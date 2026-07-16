# cf-board — shared board on Cloudflare Workers + KV

A no-login, real-time-enough shared board. One Cloudflare Worker serves a React
app **and** a KV-backed API; everyone who opens the URL sees the same live board.
No accounts, no database server, no build pipeline beyond `wrangler deploy`.

This is a genericized, feature-for-feature port of a family trip board I run in
production, re-skinned as a 4th-of-July lake-weekend board. Five tabs:

- **Meals** — day-by-day meal slots (arrival dinner → departure breakfast).
  Claim a meal, write the menu, and anyone can pledge potluck sides to it. The
  July 4th dinner gets the ★ "big cookout" badge.
- **Staples** — the grocery list. Claim, mark **Got it**, add with quantities
  (with duplicate detection).
- **Gear** — categorized packing list (Cookout / Lake & Outdoor / Cabin &
  Comfort / Games / July 4th) with claim and release.
- **Roster** — check in with just a name; set party size, arrival day, and
  dietary notes. Name matching is case-insensitive, and returning visitors tap
  their name chip to rejoin, so nobody double-counts the headcount.
- **Events** — a day-keyed weekend schedule with "I'm in" RSVPs, time-sorted
  listings, a live weather forecast card (Open-Meteo, keyless), and a hidden
  fireworks easter egg.

Plus the glue that makes it feel real: a claim-progress bar in the header, a
sync-status indicator, All/Mine/Open filters + search with a **Copy my list**
export (clipboard with mobile fallback), a Spotify playlist card, and an
**offline mode** — reads fall back to last-known-good data, writes buffer and
replay automatically when the connection returns.

```
cf-board/
  worker.js         API (/api/kv/:key) + serves the app + hourly KV backup
  wrangler.toml     config (KV binding, rate limits, backup cron, vars)
  src/app.jsx       the React app + all styles — edit here; the build bundles it
  public/index.html minimal HTML shell
```

## How it works

- **One Worker does everything.** It serves the static React app via Workers
  static assets and exposes a tiny JSON API (`GET`/`PUT /api/kv/:key`) backed by
  Workers KV. State is a handful of JSON documents — no SQL, no server to run.
- **Sections are KV keys.** Each part of the board (`board:meals:v1`,
  `board:events:v1`, …) is one key, namespaced by `BOARD_ID` so one Worker + KV
  namespace can host many independent boards. Empty sections self-seed on first
  load — and only after a *confirmed-empty* read, so a flaky connection can
  never overwrite real data with a fresh seed.
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

- **Rename the trip:** dates and day labels come from `tripDays()` in
  `src/app.jsx`; titles live in the `Gate` and `Header` components. The seeds
  (`seedMeals`, `STAPLES_SEED`, `GEAR_SEED`, `EVENTS_SEED`) are plain arrays —
  swap in your own weekend.
- **Add a section:** add a key to `KEYS`, a seed, a tab entry, and a component
  in `src/app.jsx`; add the same key to `SECTIONS` in `worker.js` so the hourly
  backup covers it.
- **Change the look:** all styles live in the `Style` component at the bottom
  of `src/app.jsx` — one CSS block, custom properties up top.
- **Weather + playlist:** swap the Open-Meteo coordinates in `TripWeather` and
  the Spotify playlist id in `EMBED_SRC`.
- **Lock it down:** set `BOARD_KEY` in `wrangler.toml` and send the matching
  `X-Board-Key` header from the app.

## License

MIT — see [LICENSE](LICENSE).
