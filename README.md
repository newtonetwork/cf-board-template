# cf-board — shared board on Cloudflare Workers + KV

A no-login, real-time-enough shared board. One Cloudflare Worker serves a React
app **and** a KV-backed API; everyone who opens the URL sees the same live board.
No accounts, no database server, no build pipeline beyond `wrangler deploy`.

This is a genericized, reusable template extracted from a family trip board I run
in production. It ships with two demo sections — a **Checklist** and a **Notes**
board — that you can rename, extend, or replace.

```
cf-board/
  worker.js         API (/api/kv/:key) + serves the app + hourly KV backup
  wrangler.toml     config (KV binding, rate limits, backup cron, vars)
  src/app.jsx       the React app — edit here; the build bundles it to public/app.js
  public/index.html HTML shell + styles
```

## How it works

- **One Worker does everything.** It serves the static React app via Workers
  static assets and exposes a tiny JSON API (`GET`/`PUT /api/kv/:key`) backed by
  Workers KV. State is a handful of JSON documents — no SQL, no server to run.
- **Sections are KV keys.** Each part of the board (`board:list:v1`,
  `board:notes:v1`, …) is one key, namespaced by `BOARD_ID` so one Worker + KV
  namespace can host many independent boards.
- **Read-merge-write, not overwrite.** The app fetches the latest copy of a
  section, applies your edit, and writes it back — so concurrent edits to
  *different* rows are safe. Same-row edits within a second are last-write-wins
  (fine at small-group scale; use a Durable Object if you need true atomicity).
- **No login.** Identity is just a display name in `localStorage`. The
  unguessable Worker URL is the access control; set `BOARD_KEY` for a light gate.
- **Hourly backups, built in.** A scheduled cron fires the Worker's
  `scheduled()` handler, which snapshots every section into timestamped `bkp:`
  KV keys (keeps ~2 days). Runs in Cloudflare's cloud 24/7 — no local machine.
- **Edge rate limiting.** Per-IP limiters shield the KV free-tier quotas with no
  user-facing friction. All optional — the Worker runs fine without them.

## Deploy (about 5 minutes)

```bash
# 0. from the cf-board/ directory
npm install
npm install -g wrangler          # or use: npx wrangler ...

# 1. log into YOUR Cloudflare account (opens a browser)
wrangler login

# 2. create the KV namespace, then paste the printed id into wrangler.toml
#    ([[kv_namespaces]] -> id = "...")
wrangler kv namespace create BOARD

# 3. ship it — the [build] hook bundles src/app.jsx first, so this is all you run
wrangler deploy
```

You'll get a free `https://cf-board.<your-subdomain>.workers.dev` URL. To use
your own domain, uncomment the `[[routes]]` block in `wrangler.toml` (if the zone
is on your Cloudflare account, deploying creates the DNS record and TLS cert for
you).

## Develop locally

```bash
npm run dev     # bundles the app, then runs `wrangler dev` with a local KV
```

## Make it yours

- **Add or rename a section:** add a KV key (e.g. `board:tasks:v1`), build a
  component with the `useSection(key)` hook in `src/app.jsx`, and add the key to
  the `SECTIONS` array in `worker.js` so it's included in backups.
- **Change the look:** all styles live in the `<style>` block in
  `public/index.html`. It already adapts to light/dark.
- **Lock it down:** set `BOARD_KEY` in `wrangler.toml` and the matching
  `BOARD_KEY` in `src/app.jsx`.

## License

MIT — see [LICENSE](LICENSE).
