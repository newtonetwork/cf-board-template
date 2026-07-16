/**
 * Shared Board — Cloudflare Worker
 *
 * A no-login, real-time-enough shared board. One Worker serves a static React
 * app AND a KV-backed API; everyone who opens the URL sees the same live board.
 *
 * Routes:
 *   GET  /api/kv/:key   -> read a board section from KV (404 if unset)
 *   PUT  /api/kv/:key   -> write a board section to KV
 *   *                   -> static assets (the app), served from ./public
 *
 * Notes:
 * - Keys are namespaced by BOARD_ID, so you can run multiple independent boards
 *   off a single Worker + KV namespace.
 * - Optional shared secret: set BOARD_KEY and the app must send X-Board-Key.
 *   For most cases the unguessable Worker URL is enough — BOARD_KEY is there if
 *   you want a light gate.
 * - KV is last-write-wins. The app does read-merge-write per section, which keeps
 *   concurrent edits to *different* rows safe. Two people editing the *same* row
 *   within the same second can still clobber — fine at small-group scale. For true
 *   atomicity, move sections to a Durable Object.
 */

const KEY_RE = /^[A-Za-z0-9:_.\-]{1,128}$/;
const MAX_BODY = 1_000_000; // 1 MB per section, well under KV's 25 MB value limit

// The board sections to snapshot on the scheduled cron (see [triggers] in
// wrangler.toml). Keep this in sync with the SECTIONS your app writes.
const SECTIONS = ['board:list:v1', 'board:notes:v1'];
const BKP_PREFIX = 'bkp:'; // backup keys live in the same namespace, outside the board:: prefix
const BKP_KEEP = 48;       // keep ~2 days of hourly snapshots

// Snapshot every section into one timestamped backup key, then prune old ones.
// Stores the raw stored JSON per section (null if a section is unset). Restore with:
//   wrangler kv key get "bkp:<iso>" --namespace-id <id> --remote
async function backup(env) {
  const board = env.BOARD_ID || 'demo';
  const sections = {};
  for (const s of SECTIONS) sections[s] = await env.BOARD.get(`${board}::${s}`);
  const ts = new Date().toISOString();
  await env.BOARD.put(`${BKP_PREFIX}${ts}`, JSON.stringify({ ts, board, sections }));

  // ISO timestamps sort lexicographically, so the oldest are first — drop the excess.
  const { keys } = await env.BOARD.list({ prefix: BKP_PREFIX });
  const names = keys.map((k) => k.name).sort();
  for (const name of names.slice(0, Math.max(0, names.length - BKP_KEEP))) {
    await env.BOARD.delete(name);
  }
}

function withCors(resp) {
  resp.headers.set('access-control-allow-origin', '*');
  resp.headers.set('access-control-allow-methods', 'GET, PUT, OPTIONS');
  resp.headers.set('access-control-allow-headers', 'content-type, x-board-key');
  return resp;
}
const json = (obj, status = 200) =>
  withCors(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }));
const text = (body, status) => withCors(new Response(body, { status }));

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

  // Edge rate limiting, keyed per client IP. Protects the KV daily quota from
  // abusive loops with zero user-facing friction. Bindings are optional so the
  // Worker still runs fine anywhere they aren't configured (e.g. local dev).
  const ip = request.headers.get('CF-Connecting-IP') || 'anon';
  if (env.API_LIMITER) {
    const { success } = await env.API_LIMITER.limit({ key: `a:${ip}` });
    if (!success) return text('slow down — too many requests', 429);
  }

  if (env.BOARD_KEY && request.headers.get('x-board-key') !== env.BOARD_KEY) {
    return text('unauthorized', 401);
  }

  const match = url.pathname.match(/^\/api\/kv\/(.+)$/);
  if (!match) return text('not found', 404);

  const rawKey = decodeURIComponent(match[1]);
  if (!KEY_RE.test(rawKey)) return text('bad key', 400);

  const board = env.BOARD_ID || 'demo';
  const kvKey = `${board}::${rawKey}`;

  if (request.method === 'GET') {
    const val = await env.BOARD.get(kvKey);
    if (val == null) return text('', 404);
    return withCors(new Response(val, { headers: { 'content-type': 'application/json' } }));
  }

  if (request.method === 'PUT') {
    if (env.WRITE_LIMITER) {
      const { success } = await env.WRITE_LIMITER.limit({ key: `w:${ip}` });
      if (!success) return text('slow down — too many writes', 429);
    }
    const body = await request.text();
    if (body.length > MAX_BODY) return text('payload too large', 413);
    try { JSON.parse(body); } catch { return text('body must be JSON', 400); }
    await env.BOARD.put(kvKey, body);
    return json({ ok: true });
  }

  return text('method not allowed', 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return env.ASSETS.fetch(request); // serve the app
  },
  // Scheduled cron (wrangler.toml [triggers]) — snapshot the board to KV backup keys.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(backup(env));
  },
};
