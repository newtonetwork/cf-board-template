import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * 4th of July Board — a shared holiday-weekend coordinator.
 *
 * Architecture:
 * - Board data (meals/staples/gear/roster/events) lives in SHARED storage (a
 *   Cloudflare Worker + KV), so every device that opens the same link sees one
 *   board. No accounts, no backend beyond the Worker.
 * - Each section is its own key to limit blast radius of last-write-wins.
 * - Mutations use read-merge-write: re-fetch freshest copy, apply ONE change by
 *   id, write back. Survives concurrent edits on different rows.
 * - Identity is device-local (localStorage). No accounts.
 * - Storage is timeout-guarded with an in-memory fallback so it never hangs and
 *   stays usable offline; buffered writes replay when the network returns.
 */

const KEYS = {
  meals: 'board:meals:v1', staples: 'board:staples:v1',
  gear: 'board:gear:v1', roster: 'board:roster:v1', events: 'board:events:v1',
};
const ME_KEY = 'me:name:v1';
const MEID_KEY = 'me:id:v1';

const uid = () => Math.random().toString(36).slice(2, 9);
const norm = (s) => (s || '').trim().toLowerCase(); // identity key: names match case-insensitively

// ---- Weekend definition --------------------------------------------------------
const fmtDay = (d) => {
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${wd} · ${md}`;
};
const DK = (dd) => fmtDay(new Date(2026, 6, dd)); // day-key label for July <dd>, 2026

// The weekend runs Wed Jul 1 -> Sun Jul 5, 2026 (the 4th is a Saturday).
function tripDays() {
  return [1, 2, 3, 4, 5].map((dd) => { const d = new Date(2026, 6, dd); return { label: fmtDay(d), date: d }; });
}
function seedMeals() {
  // Wed: arrival dinner. Thu/Fri/Sat: full days. Sun: departure breakfast.
  const spec = [['Dinner'], ['Breakfast', 'Lunch', 'Dinner'], ['Breakfast', 'Lunch', 'Dinner'], ['Breakfast', 'Lunch', 'Dinner'], ['Breakfast']];
  const out = [];
  tripDays().forEach((day, i) => {
    spec[i].forEach((slot) => {
      out.push({ id: uid(), dayLabel: day.label, slot, owner: null, big: day.date.getDate() === 4 && slot === 'Dinner' });
    });
  });
  return out;
}

const STAPLES_SEED = [
  'Coffee', 'Coffee creamer', 'Bottled water', 'Ice (a lot)', 'Beer',
  'Wine + seltzers', 'Soda + LaCroix', 'Eggs + bacon', 'Bread + bagels',
  'Chips + snacks', 'Fresh fruit', 'Condiments (ketchup/mustard/mayo)',
  'Oil + salt + pepper', 'Paper towels', 'Paper plates + cups',
  'Plastic utensils', 'Trash bags', 'Dish soap + sponges', 'Sunscreen',
  'Bug spray', "S'mores kit", 'Foil + ziplocs',
].map((name) => ({ id: uid(), name, qty: '', owner: null, got: false }));

const GEAR_CATEGORIES = ['Cookout', 'Lake & Outdoor', 'Cabin & Comfort', 'Games', 'July 4th'];
const GEAR_SEED = [
  ['Cookout', 'Grill (propane or charcoal)'], ['Cookout', 'Charcoal + lighter'],
  ['Cookout', 'Griddle / Blackstone'], ['Cookout', 'Grill tools + tongs'],
  ['Cookout', 'Big cutting board + knives'], ['Cookout', 'Cooler — drinks'],
  ['Cookout', 'Cooler — food'], ['Cookout', 'Coffee maker / French press'],
  ['Lake & Outdoor', 'Pop-up canopy / shade'], ['Lake & Outdoor', 'Camp chairs'],
  ['Lake & Outdoor', 'Beach towels'], ['Lake & Outdoor', 'Floaties / tubes'],
  ['Lake & Outdoor', 'Paddleboard / kayak'], ['Lake & Outdoor', 'Life jackets'],
  ['Lake & Outdoor', 'Bluetooth speaker'], ['Cabin & Comfort', 'Extra blankets'],
  ['Cabin & Comfort', 'Phone chargers + power strip'], ['Cabin & Comfort', 'First aid kit'],
  ['Cabin & Comfort', 'Flashlights / headlamps'], ['Cabin & Comfort', 'Firewood (if allowed)'],
  ['Games', 'Cornhole'], ['Games', 'Spikeball'], ['Games', 'Cards / Uno'],
  ['Games', 'Yard games (KanJam / ladder ball)'], ['July 4th', 'Sparklers'],
  ['July 4th', 'Glow sticks'], ['July 4th', 'Red / white / blue swag'],
].map(([category, item]) => ({ id: uid(), category, item, owner: null, notes: '' }));

// A typical small-town 4th of July weekend. Swap in your town's real listings —
// each row is just title/time/place/note, keyed to a day.
const EVENTS_SEED = [
  { dayKey: 'All week', title: 'Lake swimming & paddle rentals', time: 'Daily', place: 'The lake', note: 'Kayaks, paddleboards, and tubes at the boathouse.' },
  { dayKey: 'All week', title: 'Town green lawn games', time: 'Daily', place: 'Town green', note: 'Cornhole, spikeball, frisbee — bring your own or borrow.' },
  { dayKey: DK(3), title: 'Summer concert in the park', time: '6–8pm', place: 'The bandshell', note: 'Local band + food trucks. Bring a blanket.' },
  { dayKey: DK(3), title: 'Outdoor movie night', time: 'Starts 9:15pm', place: 'Town green', note: 'Family movie under the stars.' },
  { dayKey: DK(4), title: 'Main Street parade', time: '10am', place: 'Main St', note: 'Floats, classic cars, marching band — small-town 4th tradition.' },
  { dayKey: DK(4), title: 'Pie & watermelon contest', time: '12pm', place: 'Town green', note: 'Judged categories; entries in by 11:30am.' },
  { dayKey: DK(4), title: '4th of July cornhole tournament', time: 'Check-in 11:30am', place: 'Town green', note: 'Teams of two, bracket play. Advance sign-up to compete.' },
  { dayKey: DK(4), title: 'The big cookout', time: '4–8pm', place: 'The backyard', note: 'Ours — see the Meals tab for the menu.' },
  { dayKey: DK(4), title: 'Fireworks over the lake', time: 'Dusk (~9:30pm)', place: 'Lakefront', note: 'Best viewing from the dock or the north shore.' },
  { dayKey: DK(5), title: 'Firecracker 5K', time: '8am', place: 'Lake loop', note: 'Family-friendly race, kids divisions.' },
  { dayKey: DK(5), title: 'Farmers market', time: '9am–1pm', place: 'Main St', note: 'Local produce, makers, breakfast.' },
].map((e) => ({ id: uid(), going: [], seeded: true, url: '', ...e }));

// ---- Backend layer: shared state via Cloudflare Worker + KV; personal via localStorage ----
// The Worker serves this page AND the /api routes, so calls are same-origin.
// USE_MEMORY reflects whether the backend is currently reachable. It is NOT a
// one-way latch: every successful request clears it, so the app recovers on its
// own once the network returns (the 15s refresh loop drives that). Writes that
// fail while offline are remembered in DIRTY and replayed by flushDirty().
let USE_MEMORY = false;
const MEM = {};
const DIRTY = new Set(); // keys whose latest value hasn't reached KV yet
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
const race = (p, ms = 4000) => Promise.race([p, timeout(ms)]);
const kvUrl = (key) => `/api/kv/${encodeURIComponent(key)}`;

// Replay writes that were buffered while offline. Stops at the first failure so
// we don't hammer a still-down backend; remaining keys retry on the next pass.
async function flushDirty() {
  for (const key of [...DIRTY]) {
    try {
      const res = await race(fetch(kvUrl(key), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MEM[key]) }));
      if (!res.ok) throw new Error('PUT ' + res.status);
      DIRTY.delete(key);
    } catch (e) { return; }
  }
}

async function getJSON(key) { // shared board state, stored in KV
  try {
    const res = await race(fetch(kvUrl(key), { headers: { accept: 'application/json' } }));
    USE_MEMORY = false;           // we reached the backend — we're online
    if (DIRTY.size) flushDirty(); // fire-and-forget; refresh() awaits its own flush
    if (res.status === 404) return key in MEM ? MEM[key] : null;
    if (!res.ok) throw new Error('GET ' + res.status);
    const txt = await res.text();
    const val = txt ? JSON.parse(txt) : null;
    if (val != null) MEM[key] = val; // cache last-known-good so a later failed read falls back to real data
    return val;
  } catch (e) {
    USE_MEMORY = true;
    return key in MEM ? MEM[key] : null;
  }
}
async function setJSON(key, value) {
  MEM[key] = value;
  try {
    const res = await race(fetch(kvUrl(key), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }));
    if (!res.ok) throw new Error('PUT ' + res.status);
    USE_MEMORY = false;
    DIRTY.delete(key);
    if (DIRTY.size) flushDirty();
  } catch (e) {
    USE_MEMORY = true;
    DIRTY.add(key); // remember to retry this write once we're back online
  }
}
// Personal, device-local identity — plain localStorage since this is self-hosted.
function getRaw(key) { try { return localStorage.getItem(key); } catch (e) { return MEM[key] || null; } }
function setRaw(key, value) { try { localStorage.setItem(key, value); } catch (e) { MEM[key] = value; } }
// Re-fetch freshest, mutate, write back (read-merge-write keeps concurrent claims safe).
// CRITICAL: if the re-read fails (timeout/blip), getJSON returns null — we must NOT
// proceed, or we'd apply the mutation to an empty list and overwrite the whole
// section. Abort instead; callers surface a retry. (A genuinely empty existing
// list reads back as [], not null, so this only blocks failed reads.)
async function mutate(key, mutator) {
  const current = await getJSON(key);
  if (current == null) throw new Error('mutate aborted: could not read ' + key);
  const next = mutator(current);
  await setJSON(key, next);
  return next;
}

// Load a section, seeding ONLY when a successful read confirms it's empty. If the
// read FAILED, show the seed locally but never persist it — otherwise a flaky
// connection overwrites real remote data with a fresh seed (this is what reset
// everyone's meal claims). The next good refresh replaces the local seed.
async function loadOrSeed(key, seedFn) {
  const v = await getJSON(key);
  if (v != null) return v;          // got real data
  if (USE_MEMORY) return seedFn();  // read failed — local seed only, do NOT write
  const seeded = seedFn();          // confirmed-empty key — safe to seed + persist
  await setJSON(key, seeded);
  return seeded;
}

// Clipboard with a graceful fallback (sandboxed mobile iframes can block both paths).
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
function buildMyList(tab, items) {
  const titles = { meals: 'My 4th of July meal duties', staples: 'My 4th of July grocery list', gear: 'My 4th of July packing list' };
  const lines = items.map((it) => {
    if (tab === 'meals') return `- ${it.dayLabel} · ${it.slot}`;
    if (tab === 'staples') return `- ${it.name}${it.qty ? ` (${it.qty})` : ''}`;
    return `- ${it.item}`;
  });
  return `${titles[tab] || 'My 4th of July list'}\n${lines.join('\n')}`;
}

// ---- Component ---------------------------------------------------------------
function App() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [personId, setPersonId] = useState(null);
  const [nameInput, setNameInput] = useState('');
  const [tab, setTab] = useState('meals');
  const [data, setData] = useState({ meals: [], staples: [], gear: [], roster: [], events: [] });
  const [pending, setPending] = useState({});
  const [sync, setSync] = useState({ state: 'idle', at: null });
  const [mode, setMode] = useState(null); // 'shared' | 'memory'
  const [editingName, setEditingName] = useState(false);
  const [filter, setFilter] = useState('all'); // 'all' | 'mine' | 'open'
  const [query, setQuery] = useState('');
  const [addStaple, setAddStaple] = useState({ name: '', qty: '' });
  const [addGear, setAddGear] = useState({ item: '', category: 'Cookout', notes: '' });
  const [addEvent, setAddEvent] = useState({ title: '', dayKey: 'All week', details: '' });
  const [myRow, setMyRow] = useState({ party: 1, arrival: '', diet: '' });
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(null);
  const [egg, setEgg] = useState(false);
  const mounted = useRef(true);
  const rosterInit = useRef(false);
  const saveTimer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      await flushDirty(); // push anything buffered while offline before reading fresh state
      const [meals, staples, gear, roster, events] = await Promise.all([
        getJSON(KEYS.meals), getJSON(KEYS.staples), getJSON(KEYS.gear), getJSON(KEYS.roster), getJSON(KEYS.events),
      ]);
      if (!mounted.current) return;
      setData({ meals: meals || [], staples: staples || [], gear: gear || [], roster: roster || [], events: events || [] });
      setSync({ state: 'ok', at: new Date() });
      setMode(USE_MEMORY ? 'memory' : 'shared');
    } catch (e) { if (mounted.current) setSync({ state: 'error', at: new Date() }); }
  }, []);

  // Mount: identity, seed-if-empty, ensure roster row, start live refresh.
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const n = getRaw(ME_KEY);
        let pid = getRaw(MEID_KEY);
        if (!pid) { pid = uid() + uid(); setRaw(MEID_KEY, pid); }
        if (mounted.current) { setPersonId(pid); if (n) setMe(n); }

        let meals = await loadOrSeed(KEYS.meals, seedMeals);
        let staples = await loadOrSeed(KEYS.staples, () => STAPLES_SEED);
        let gear = await loadOrSeed(KEYS.gear, () => GEAR_SEED);
        let roster = await loadOrSeed(KEYS.roster, () => []);
        let events = await loadOrSeed(KEYS.events, () => EVENTS_SEED);
        // Reconcile identity by NAME (case-insensitive). If a roster row already
        // exists for this name, adopt its id + canonical spelling rather than
        // adding a second row — this is what stops a person from duplicating
        // across devices or after their localStorage was wiped. Only create a
        // row when the name is genuinely new to the board.
        if (n) {
          const mine = roster.find((r) => norm(r.name) === norm(n));
          if (mine) {
            if (mine.id !== pid) { pid = mine.id; setRaw(MEID_KEY, pid); }
            if (mine.name !== n) setRaw(ME_KEY, mine.name);
            if (mounted.current) { setPersonId(pid); setMe(mine.name); }
          } else if (pid) {
            roster = [...roster, { id: pid, name: n, party: 1, arrival: '', diet: '', updated: new Date().toISOString() }];
            await setJSON(KEYS.roster, roster);
          }
        }
        if (mounted.current) { setData({ meals, staples, gear, roster, events }); setSync({ state: 'ok', at: new Date() }); }
      } catch (e) {
        if (mounted.current) setData({ meals: seedMeals(), staples: STAPLES_SEED, gear: GEAR_SEED, roster: [], events: EVENTS_SEED });
      } finally {
        if (mounted.current) { setMode(USE_MEMORY ? 'memory' : 'shared'); setLoading(false); }
      }
    })();

    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    const iv = setInterval(refresh, 15000);
    return () => { mounted.current = false; window.removeEventListener('focus', onFocus); clearInterval(iv); clearTimeout(saveTimer.current); };
  }, [refresh]);

  // Inject fonts once.
  useEffect(() => {
    let v = document.querySelector('meta[name="viewport"]');
    const made = !v;
    if (!v) { v = document.createElement('meta'); v.setAttribute('name', 'viewport'); }
    v.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover');
    if (made) document.head.appendChild(v);

    const id = 'board-fonts';
    if (document.getElementById(id)) return;
    const l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(l);
  }, []);

  // Initialize my editable roster row from stored data, once.
  useEffect(() => {
    if (rosterInit.current || !me || !personId) return;
    const row = data.roster.find((r) => r.id === personId);
    if (row) setMyRow({ party: row.party || 1, arrival: row.arrival || '', diet: row.diet || '' });
    rosterInit.current = true;
  }, [me, personId, data.roster]);

  const checkIn = async () => {
    const name = nameInput.trim();
    if (!name) return;
    setRaw(ME_KEY, name);
    setMe(name); setEditingName(false);
    let pid = personId;
    const next = await mutate(KEYS.roster, (arr) => {
      // Match an existing person by name first, so retyping a name never spawns
      // a second roster row; fall back to this device's id, then create.
      const byName = arr.findIndex((r) => norm(r.name) === norm(name));
      if (byName >= 0) { pid = arr[byName].id; const c = [...arr]; c[byName] = { ...c[byName], name }; return c; }
      const byId = arr.findIndex((r) => r.id === pid);
      if (byId >= 0) { const c = [...arr]; c[byId] = { ...c[byId], name }; return c; }
      if (!pid) pid = uid() + uid();
      return [...arr, { id: pid, name, party: 1, arrival: '', diet: '', updated: new Date().toISOString() }];
    });
    if (pid && pid !== personId) { setRaw(MEID_KEY, pid); if (mounted.current) setPersonId(pid); }
    if (mounted.current) setData((d) => ({ ...d, roster: next }));
  };

  // Returning person tapping their name on the gate: adopt that roster row's
  // identity instead of minting a new one. This is what prevents duplicate
  // headcount when localStorage didn't survive (e.g. the link was opened in an
  // in-app browser from a text, which gets a fresh, empty storage each time).
  const rejoinAs = (row) => {
    setRaw(MEID_KEY, row.id);
    setRaw(ME_KEY, row.name);
    setPersonId(row.id);
    setMe(row.name);
    setEditingName(false);
  };

  // Generic mutation runner with optimistic per-item pending flag.
  const run = async (section, id, mutator) => {
    setPending((p) => ({ ...p, [id]: true }));
    setSync((s) => ({ state: 'saving', at: s.at }));
    try {
      const next = await mutate(KEYS[section], mutator);
      if (!mounted.current) return;
      setData((d) => ({ ...d, [section]: next }));
      setSync({ state: 'ok', at: new Date() });
    } catch (e) {
      if (mounted.current) setSync((s) => ({ state: 'error', at: s.at }));
    } finally {
      if (mounted.current) setPending((p) => { const n = { ...p }; delete n[id]; return n; });
    }
  };

  const claim = (section, id) => run(section, id, (arr) => arr.map((x) => (x.id === id ? { ...x, owner: me } : x)));
  // Release clears the meal menu too — it was the prior owner's plan, the next
  // person picks their own. Harmless no-op for sections without a menu field.
  const release = (section, id) => run(section, id, (arr) => arr.map((x) => (x.id === id ? { ...x, owner: null, ...(section === 'meals' ? { menu: '' } : {}) } : x)));
  const setMenu = (id, menu) => run('meals', id, (arr) => arr.map((x) => (x.id === id ? { ...x, menu } : x)));
  // Potluck sides: anyone can pledge a side dish to a meal; you can remove your own.
  const addSide = (mealId, name) => run('meals', mealId, (arr) => arr.map((x) => (x.id === mealId ? { ...x, sides: [...(x.sides || []), { id: uid(), name, by: me }] } : x)));
  const removeSide = (mealId, sideId) => run('meals', mealId, (arr) => arr.map((x) => (x.id === mealId ? { ...x, sides: (x.sides || []).filter((s) => s.id !== sideId) } : x)));
  const toggleGot = (id) => run('staples', id, (arr) => arr.map((x) => (x.id === id ? { ...x, got: !x.got } : x)));
  const removeItem = (section, id) => run(section, id, (arr) => arr.filter((x) => x.id !== id));

  const addStapleItem = async () => {
    const name = addStaple.name.trim();
    if (!name) return;
    const dup = data.staples.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
    if (dup && !window.confirm(`"${name}" looks like it's already on the list. Add it anyway?`)) return;
    const item = { id: uid(), name, qty: addStaple.qty.trim(), owner: null, got: false };
    setAddStaple({ name: '', qty: '' });
    await run('staples', item.id, (arr) => [...arr, item]);
  };
  const addGearItem = async () => {
    const itemName = addGear.item.trim();
    if (!itemName) return;
    const dup = data.gear.find((g) => g.item.trim().toLowerCase() === itemName.toLowerCase());
    if (dup && !window.confirm(`"${itemName}" looks like it's already on the list. Add it anyway?`)) return;
    const item = { id: uid(), item: itemName, category: addGear.category, notes: addGear.notes.trim(), owner: null };
    setAddGear({ item: '', category: addGear.category, notes: '' });
    await run('gear', item.id, (arr) => [...arr, item]);
  };

  const toggleGoing = (id) => {
    // Easter egg: reveal the clip every time you join the fireworks event.
    const ev = data.events.find((e) => e.id === id);
    const joining = ev && !(ev.going || []).includes(me);
    if (joining && /fireworks/i.test(ev.title)) setEgg(true);
    return run('events', id, (arr) => arr.map((e) => {
      if (e.id !== id) return e;
      const going = e.going || [];
      return { ...e, going: going.includes(me) ? going.filter((x) => x !== me) : [...going, me] };
    }));
  };
  const addEventItem = async () => {
    const title = addEvent.title.trim();
    if (!title) return;
    const item = { id: uid(), dayKey: addEvent.dayKey, title, time: '', place: '', note: addEvent.details.trim(), url: '', going: [], seeded: false };
    setAddEvent({ title: '', dayKey: addEvent.dayKey, details: '' });
    await run('events', item.id, (arr) => [...arr, item]);
  };

  // Roster: edit my own row, debounced write so steppers/typing don't spam storage.
  const updateMyRow = (partial) => {
    setMyRow((prev) => {
      const mergedRow = { ...prev, ...partial };
      clearTimeout(saveTimer.current);
      setSync((s) => ({ state: 'saving', at: s.at }));
      saveTimer.current = setTimeout(async () => {
        if (!personId) return;
        const next = await mutate(KEYS.roster, (arr) => {
          const full = { id: personId, name: me, party: mergedRow.party, arrival: mergedRow.arrival, diet: mergedRow.diet, updated: new Date().toISOString() };
          const i = arr.findIndex((r) => r.id === personId);
          if (i >= 0) { const c = [...arr]; c[i] = full; return c; }
          return [...arr, full];
        });
        if (mounted.current) { setData((d) => ({ ...d, roster: next })); setSync({ state: 'ok', at: new Date() }); }
      }, 500);
      return mergedRow;
    });
  };

  // ---- Derived ----
  const claimedCount =
    data.meals.filter((m) => m.owner).length +
    data.staples.filter((s) => s.owner || s.got).length +
    data.gear.filter((g) => g.owner).length;
  const totalCount = data.meals.length + data.staples.length + data.gear.length;
  const pct = totalCount ? Math.round((claimedCount / totalCount) * 100) : 0;
  const peopleCount = data.roster.reduce((sum, r) => sum + (Number(r.party) || 0), 0);
  const dayLabels = [...new Set(data.meals.map((m) => m.dayLabel))];

  const q = query.trim().toLowerCase();
  const matchQ = (text) => !q || text.toLowerCase().includes(q);
  const passFilter = (item, isStaple) => {
    if (filter === 'mine') return item.owner === me;
    if (filter === 'open') return isStaple ? (!item.owner && !item.got) : !item.owner;
    return true;
  };
  const fMeals = data.meals.filter((m) => passFilter(m, false) && matchQ(`${m.slot} ${m.dayLabel}`));
  const fStaples = data.staples.filter((s) => passFilter(s, true) && matchQ(`${s.name} ${s.qty}`));
  const fGear = data.gear.filter((g) => passFilter(g, false) && matchQ(`${g.item} ${g.notes} ${g.category}`));

  const activeArr = tab === 'meals' ? data.meals : tab === 'staples' ? data.staples : tab === 'gear' ? data.gear : [];
  const mineCount = activeArr.filter((x) => x.owner === me).length;
  const openCount = activeArr.filter((x) => (tab === 'staples' ? (!x.owner && !x.got) : !x.owner)).length;

  const emptyMsg = q ? `No matches for "${query.trim()}".`
    : filter === 'mine' ? "Nothing of yours here yet — switch to All and grab something."
    : filter === 'open' ? 'All claimed here. Nice work, team.'
    : 'Nothing here yet.';

  const activeFiltered = tab === 'meals' ? fMeals : tab === 'staples' ? fStaples : fGear;
  const handleCopy = async () => {
    const text = buildMyList(tab, activeFiltered);
    const ok = await copyText(text);
    if (ok) { setCopied(true); setTimeout(() => { if (mounted.current) setCopied(false); }, 1600); }
    else setCopyFallback(text);
  };

  return (
    <div className="board">
      <Style />
      {!me ? (
        <Gate value={nameInput} onChange={setNameInput} onSubmit={checkIn} roster={data.roster} onPick={rejoinAs} loading={loading} />
      ) : loading ? (
        <div className="loading"><div className="spinner" /><span>Loading the board…</span></div>
      ) : (
        <div className="app">
          <Header
            me={me} editing={editingName} nameInput={nameInput}
            onEditName={() => { setNameInput(me); setEditingName(true); }}
            onName={setNameInput} onSaveName={checkIn}
            onRefresh={refresh} sync={sync}
            pct={pct} claimed={claimedCount} total={totalCount} people={peopleCount}
          />

          {mode === 'memory' && (
            <div className="mode-banner">
              <strong>Working offline.</strong> Can't reach the board right now, so changes are staying on this device. Check your connection — they'll sync once it's back.
            </div>
          )}

          <Playlist />

          <nav className="tabs">
            {[['meals', 'Meals'], ['staples', 'Staples'], ['gear', 'Gear'], ['roster', 'Roster'], ['events', 'Events']].map(([k, label]) => (
              <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
                {label}
                <span className="tab-count">{k === 'roster' ? peopleCount : k === 'events' ? data.events.length : remaining(data, k)}</span>
              </button>
            ))}
          </nav>

          {tab !== 'roster' && tab !== 'events' && (
            <FilterBar
              filter={filter} setFilter={setFilter} query={query} setQuery={setQuery}
              mineCount={mineCount} openCount={openCount}
              onCopy={handleCopy} copied={copied} copyDisabled={!activeFiltered.length}
            />
          )}

          <main className="content">
            {tab === 'meals' && <Meals data={fMeals} me={me} pending={pending} claim={claim} release={release} setMenu={setMenu} addSide={addSide} removeSide={removeSide} empty={emptyMsg} />}
            {tab === 'staples' && (
              <Staples
                data={fStaples} showAdd={filter === 'all' && !q} pending={pending} claim={claim} release={release}
                toggleGot={toggleGot} remove={removeItem} add={addStaple} setAdd={setAddStaple} onAdd={addStapleItem} empty={emptyMsg}
              />
            )}
            {tab === 'gear' && (
              <Gear
                data={fGear} showAdd={filter === 'all' && !q} pending={pending} claim={claim} release={release}
                remove={removeItem} add={addGear} setAdd={setAddGear} onAdd={addGearItem} empty={emptyMsg}
              />
            )}
            {tab === 'roster' && (
              <Roster
                roster={data.roster} me={me} personId={personId} myRow={myRow} update={updateMyRow}
                dayLabels={dayLabels} people={peopleCount}
              />
            )}
            {tab === 'events' && (
              <Events
                data={data.events} me={me} pending={pending} toggleGoing={toggleGoing} remove={removeItem}
                add={addEvent} setAdd={setAddEvent} onAdd={addEventItem} dayLabels={dayLabels}
              />
            )}
          </main>

          <footer className="foot">
            Everyone with this link sees the same board. Grab what you're bringing — it shows up for the whole crew.
          </footer>

          {copyFallback && (
            <div className="copy-fallback" onClick={() => setCopyFallback(null)}>
              <div className="copy-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="copy-sheet-head">Tap and hold the text to copy it</div>
                <textarea className="copy-text" readOnly value={copyFallback} onFocus={(e) => e.target.select()} />
                <button className="btn primary" onClick={() => setCopyFallback(null)}>Done</button>
              </div>
            </div>
          )}

          {egg && <FireworksEgg onClose={() => setEgg(false)} />}
        </div>
      )}
    </div>
  );
}

const _root = createRoot(document.getElementById('root'));
_root.render(React.createElement(App));

// ---- Helpers / subviews ------------------------------------------------------
function remaining(data, k) {
  if (k === 'meals') return data.meals.filter((m) => !m.owner).length;
  if (k === 'staples') return data.staples.filter((s) => !s.owner && !s.got).length;
  if (k === 'gear') return data.gear.filter((g) => !g.owner).length;
  return 0;
}
const partyLabel = (n) => (Number(n) === 1 ? '1 person' : `${Number(n) || 0} people`);

// Parse a sortable start-of-day minute from a free-text time string
// ("9:30–10:30am", "6–8pm", "Starts 9:15pm", "Dusk (~7:30–10pm)"). The am/pm can
// trail the range, so fall back to the next meridiem in the string. Untimed rows
// sort to the end.
function startMinutes(time) {
  if (!time) return 1e9;
  const s = time.toLowerCase();
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
  if (!m) return 1e9;
  let hr = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] || (s.slice(m.index + m[0].length).match(/am|pm/) || [])[0];
  if (mer === 'pm' && hr !== 12) hr += 12;
  if (mer === 'am' && hr === 12) hr = 0;
  return hr * 60 + min;
}

function Gate({ value, onChange, onSubmit, roster, onPick, loading }) {
  const people = (roster || []).filter((r) => r.name);
  const [adding, setAdding] = useState(false);
  const showList = people.length > 0 && !adding;
  return (
    <div className="gate">
      <div className="gate-sign">
        <div className="eyebrow">Cabin check-in</div>
        <h1 className="gate-title">The 4th<span className="amp"> · </span>at the Lake</h1>
        {loading ? (
          <p className="gate-sub">Loading the board…</p>
        ) : showList ? (
          <>
            <p className="gate-sub">Welcome back — tap your name to jump in. (Tapping keeps you as one person on the roster, so the headcount stays right.)</p>
            <div className="gate-people">
              {people.map((r) => (
                <button key={r.id} className="name-chip" onClick={() => onPick(r)}>{r.name}</button>
              ))}
            </div>
            <button className="gate-new-link" onClick={() => setAdding(true)}>I'm someone new →</button>
          </>
        ) : (
          <>
            <p className="gate-sub">First name's fine — add a last initial if there's two of you. We'll put it next to whatever you grab.</p>
            <div className="gate-row">
              <input className="input gate-input" placeholder="Your name" value={value}
                onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} autoFocus />
              <button className="btn primary" onClick={onSubmit}>Check in</button>
            </div>
            {people.length > 0 && <button className="gate-new-link" onClick={() => setAdding(false)}>← Back to the name list</button>}
          </>
        )}
      </div>
    </div>
  );
}

function Header({ me, editing, nameInput, onEditName, onName, onSaveName, onRefresh, sync, pct, claimed, total, people }) {
  return (
    <header className="header">
      <div className="topo" />
      <div className="header-inner">
        <div className="header-top">
          <div className="header-titles">
            <div className="eyebrow light">The Lake House · Small Town, USA</div>
            <h1 className="trip-title">The 4th at the Lake</h1>
            <div className="trip-meta">Jul 1–5 · {people} {people === 1 ? 'person' : 'people'} coming</div>
            <div className="usa250"><span className="star">★</span>America's 250th · Jul 4, 2026</div>
          </div>
        </div>

        <div className="whoami">
          {editing ? (
            <>
              <input className="input name-input" value={nameInput} onChange={(e) => onName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSaveName()} autoFocus />
              <button className="btn tiny" onClick={onSaveName}>Save</button>
            </>
          ) : (
            <button className="name-pill" onClick={onEditName}>You're checked in as <strong>{me}</strong> · change</button>
          )}
          <button className="ghost-btn whoami-sync" onClick={onRefresh} title="Refresh"><SyncDot sync={sync} /></button>
        </div>

        <div className="progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
            <div className="progress-flag" style={{ left: `calc(${pct}% - 2px)` }} />
          </div>
          <div className="progress-label">{claimed} of {total} squared away · {pct}%</div>
        </div>
      </div>
      <div className="flag-band" />
    </header>
  );
}

function SyncDot({ sync }) {
  const map = { ok: 'Synced', saving: 'Saving…', error: 'Retry', idle: '' };
  return (
    <span className={`sync sync-${sync.state}`}>
      <span className="sync-dot" />
      {sync.state === 'ok' && sync.at ? `Synced ${sync.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : map[sync.state]}
    </span>
  );
}

function FilterBar({ filter, setFilter, query, setQuery, mineCount, openCount, onCopy, copied, copyDisabled }) {
  const segs = [['all', 'All', null], ['mine', 'Mine', mineCount], ['open', 'Open', openCount]];
  return (
    <div className="filter-bar">
      <div className="seg">
        {segs.map(([k, label, count]) => (
          <button key={k} className={`seg-btn ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
            {label}{count != null && <span className="seg-count">{count}</span>}
          </button>
        ))}
      </div>
      <div className="search">
        <input className="input" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button className="search-clear" onClick={() => setQuery('')} title="Clear">×</button>}
      </div>
      {filter === 'mine' && (
        <button className={`btn copy-btn ${copied ? 'copied' : ''}`} onClick={onCopy} disabled={copyDisabled}>
          {copied ? 'Copied' : 'Copy my list'}
        </button>
      )}
    </div>
  );
}

function Meals({ data, me, pending, claim, release, setMenu, addSide, removeSide, empty }) {
  if (!data.length) return <Empty msg={empty} />;
  const days = [...new Set(data.map((m) => m.dayLabel))];
  return (
    <div className="section">
      {days.map((day) => (
        <div key={day} className="day-block">
          <div className="day-head">{day}</div>
          {data.filter((m) => m.dayLabel === day).map((m) => (
            <MealRow key={m.id} m={m} me={me} mine={m.owner === me} pending={pending}
              claim={claim} release={release} setMenu={setMenu} addSide={addSide} removeSide={removeSide} />
          ))}
        </div>
      ))}
    </div>
  );
}

function MealRow({ m, me, mine, pending, claim, release, setMenu, addSide, removeSide }) {
  const [text, setText] = useState(m.menu || '');
  const [adding, setAdding] = useState(false);
  const [sideText, setSideText] = useState('');
  const focused = useRef(false);
  // Sync down external changes (refresh / another device) only when not editing.
  useEffect(() => { if (!focused.current) setText(m.menu || ''); }, [m.menu]);
  const commit = () => { const t = text.trim(); if (t !== (m.menu || '')) setMenu(m.id, t); };
  const sides = m.sides || [];
  const submitSide = () => {
    const n = sideText.trim();
    if (n) addSide(m.id, n);
    setSideText(''); setAdding(false);
  };
  return (
    <div className={`row meal ${m.owner ? 'claimed' : ''} ${m.big ? 'big' : ''}`}>
      <div className="row-main">
        <span className="slot">{m.slot}{m.big && <span className="badge">★ the big cookout</span>}</span>
        {m.owner && <span className="owner">{m.owner} has it</span>}
        {mine ? (
          <input
            className="menu-input" value={text} placeholder="What's on the menu? (e.g. tacos + chips & guac)"
            onChange={(e) => setText(e.target.value)}
            onFocus={() => { focused.current = true; }}
            onBlur={() => { focused.current = false; commit(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          />
        ) : m.menu ? <span className="menu-text">🍽 {m.menu}</span> : null}

        {sides.length > 0 && (
          <div className="sides">
            {sides.map((s) => (
              <span key={s.id} className="side-chip">
                🥗 {s.name} · {s.by}
                {s.by === me && <button className="side-x" onClick={() => removeSide(m.id, s.id)} title="Remove">×</button>}
              </span>
            ))}
          </div>
        )}
        {adding ? (
          <input
            className="menu-input side-input" value={sideText} autoFocus placeholder="Side you're bringing…"
            onChange={(e) => setSideText(e.target.value)}
            onBlur={submitSide}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setSideText(''); setAdding(false); } }}
          />
        ) : (
          <button className="add-side" onClick={() => setAdding(true)}>+ add a side</button>
        )}
      </div>
      {m.owner
        ? <button className="btn ghost" disabled={pending[m.id]} onClick={() => release('meals', m.id)}>Release</button>
        : <button className="btn claim" disabled={pending[m.id]} onClick={() => claim('meals', m.id)}>I've got this</button>}
    </div>
  );
}

function Staples({ data, showAdd, pending, claim, release, toggleGot, remove, add, setAdd, onAdd, empty }) {
  return (
    <div className="section">
      {showAdd && (
        <div className="add-card">
          <input className="input" placeholder="Add a staple…" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} />
          <input className="input qty" placeholder="Qty" value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} />
          <button className="btn primary" onClick={onAdd}>Add</button>
        </div>
      )}
      {!data.length ? <Empty msg={empty} /> : data.map((s) => (
        <div key={s.id} className={`row ${s.owner ? 'claimed' : ''} ${s.got ? 'got' : ''}`}>
          <div className="row-main">
            <span className="item-name">{s.name}{s.qty && <span className="qty-tag">{s.qty}</span>}</span>
            {s.owner && <span className="owner">{s.owner}{s.got ? ' — got it' : ''}</span>}
          </div>
          <div className="row-actions">
            {s.owner && <button className={`chip ${s.got ? 'on' : ''}`} disabled={pending[s.id]} onClick={() => toggleGot(s.id)}>Got it</button>}
            {s.owner
              ? <button className="btn ghost" disabled={pending[s.id]} onClick={() => release('staples', s.id)}>Release</button>
              : <button className="btn claim" disabled={pending[s.id]} onClick={() => claim('staples', s.id)}>I'll bring it</button>}
            <button className="x" onClick={() => remove('staples', s.id)} title="Remove">×</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Gear({ data, showAdd, pending, claim, release, remove, add, setAdd, onAdd, empty }) {
  return (
    <div className="section">
      {showAdd && (
        <div className="add-card">
          <input className="input" placeholder="Add gear…" value={add.item} onChange={(e) => setAdd({ ...add, item: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} />
          <select className="input select" value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })}>
            {GEAR_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button className="btn primary" onClick={onAdd}>Add</button>
        </div>
      )}
      {!data.length ? <Empty msg={empty} /> : GEAR_CATEGORIES.map((cat) => {
        const items = data.filter((g) => g.category === cat);
        if (!items.length) return null;
        return (
          <div key={cat} className="day-block">
            <div className="day-head">{cat}</div>
            {items.map((g) => (
              <div key={g.id} className={`row ${g.owner ? 'claimed' : ''}`}>
                <div className="row-main">
                  <span className="item-name">{g.item}</span>
                  {g.owner ? <span className="owner">{g.owner} has it</span> : g.notes && <span className="notes">{g.notes}</span>}
                </div>
                <div className="row-actions">
                  {g.owner
                    ? <button className="btn ghost" disabled={pending[g.id]} onClick={() => release('gear', g.id)}>Release</button>
                    : <button className="btn claim" disabled={pending[g.id]} onClick={() => claim('gear', g.id)}>I've got this</button>}
                  <button className="x" onClick={() => remove('gear', g.id)} title="Remove">×</button>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Roster({ roster, me, personId, myRow, update, dayLabels, people }) {
  const others = roster.filter((r) => r.id !== personId);
  const arrivalOpts = ['', ...dayLabels, 'Arriving later', 'Not sure yet'];
  return (
    <div className="section">
      <div className="roster-summary">{people} {people === 1 ? 'person' : 'people'} coming so far</div>

      <div className="you-card">
        <div className="you-head">You · {me}</div>
        <div className="field">
          <label>How many in your party?</label>
          <div className="stepper">
            <button onClick={() => update({ party: Math.max(1, (Number(myRow.party) || 1) - 1) })}>−</button>
            <span>{myRow.party}</span>
            <button onClick={() => update({ party: Math.min(12, (Number(myRow.party) || 1) + 1) })}>+</button>
          </div>
        </div>
        <div className="field">
          <label>Arriving</label>
          <select className="input select wide" value={myRow.arrival} onChange={(e) => update({ arrival: e.target.value })}>
            {arrivalOpts.map((o) => <option key={o || 'pick'} value={o}>{o || 'When are you arriving?'}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Allergies / dietary (optional)</label>
          <input className="input wide" placeholder="e.g. nut allergy, vegetarian" value={myRow.diet} onChange={(e) => update({ diet: e.target.value })} />
        </div>
      </div>

      <div className="day-head">Everyone else</div>
      {!others.length ? (
        <Empty msg="Once others open the link and check in, they'll show up here." />
      ) : others.map((r) => (
        <div key={r.id} className="person-row">
          <div className="row-main">
            <span className="item-name">{r.name} <span className="qty-tag">{partyLabel(r.party)}</span></span>
            <span className="person-meta">{r.arrival ? r.arrival : 'Arrival TBD'}{r.diet ? ` · ${r.diet}` : ''}</span>
          </div>
        </div>
      ))}

      <div className="join-hint">
        <strong>Getting the crew on here:</strong> send everyone this same link. They check in with their name, and anything they grab shows up for the whole crew.
      </div>
    </div>
  );
}

function Events({ data, me, pending, toggleGoing, remove, add, setAdd, onAdd, dayLabels }) {
  const order = ['All week', ...dayLabels];
  const keys = [...new Set(data.map((e) => e.dayKey))];
  const ordered = [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))];
  const dayOpts = ['All week', ...dayLabels];
  return (
    <div className="section">
      <TripWeather />
      <div className="add-card events-add">
        <input className="input" placeholder="Add an outing…" value={add.title} onChange={(e) => setAdd({ ...add, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} />
        <select className="input select" value={add.dayKey} onChange={(e) => setAdd({ ...add, dayKey: e.target.value })}>
          {dayOpts.map((d) => <option key={d}>{d}</option>)}
        </select>
        <input className="input" placeholder="Time / place (optional)" value={add.details} onChange={(e) => setAdd({ ...add, details: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAdd()} />
        <button className="btn primary" onClick={onAdd}>Add</button>
      </div>

      {ordered.map((day) => (
        <div key={day} className="day-block">
          <div className="day-head">{day}{day.includes('Jul 4') && <span className="day-star"> ★</span>}</div>
          {data.filter((e) => e.dayKey === day).sort((a, b) => startMinutes(a.time) - startMinutes(b.time)).map((e) => {
            const going = e.going || [];
            const inGoing = going.includes(me);
            return (
              <div key={e.id} className={`row event ${inGoing ? 'claimed' : ''}`}>
                <div className="row-main">
                  <span className="item-name">{e.title}</span>
                  {(e.time || e.place) && <span className="event-meta">{[e.time, e.place].filter(Boolean).join(' · ')}</span>}
                  {e.note && <span className="notes">{e.note}</span>}
                  {going.length > 0 && <span className="going-names">Going: {going.join(', ')}</span>}
                </div>
                <div className="row-actions">
                  <button className={`btn ${inGoing ? 'ghost' : 'claim'}`} disabled={pending[e.id]} onClick={() => toggleGoing(e.id)}>
                    {inGoing ? 'Leave' : "I'm in"}{going.length > 0 ? ` · ${going.length}` : ''}
                  </button>
                  {!e.seeded && <button className="x" onClick={() => remove('events', e.id)} title="Remove">×</button>}
                </div>
              </div>
            );
          })}
        </div>
      ))}

      <div className="source-note">
        Seeded with a typical small-town 4th of July weekend — swap in your town's real listings. Summer schedules shift, so confirm times day-of.
      </div>
    </div>
  );
}

function Empty({ msg }) {
  return <div className="empty">{msg}</div>;
}

// Weekend forecast via Open-Meteo (free, no key, CORS-open). The original pinned
// the trip's fixed dates; the template asks for the next 5 days so the card is
// alive whenever you open the demo. Cached at module scope so flipping between
// tabs doesn't refetch. Fails silent (renders nothing) since it's a nice-to-have.
// Coordinates: Lake George, NY — swap in your own lake.
let WX_CACHE = null;
const wxIcon = (c) =>
  c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️'
  : c <= 57 ? '🌦️' : c <= 67 ? '🌧️' : c <= 77 ? '🌨️' : c <= 82 ? '🌦️'
  : c <= 86 ? '🌨️' : '⛈️';

function TripWeather() {
  const [days, setDays] = useState(WX_CACHE);
  useEffect(() => {
    if (WX_CACHE) return;
    let alive = true;
    (async () => {
      try {
        const url = 'https://api.open-meteo.com/v1/forecast?latitude=43.426&longitude=-73.712'
          + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
          + '&temperature_unit=fahrenheit&timezone=America%2FNew_York'
          + '&forecast_days=5';
        const res = await fetch(url);
        if (!res.ok) throw new Error('wx ' + res.status);
        const j = await res.json();
        const out = (j.daily?.time || []).map((t, i) => {
          const dt = new Date(t + 'T12:00:00');
          return {
            dow: dt.toLocaleDateString('en-US', { weekday: 'short' }),
            icon: wxIcon(j.daily.weather_code[i]),
            hi: Math.round(j.daily.temperature_2m_max[i]),
            lo: Math.round(j.daily.temperature_2m_min[i]),
          };
        });
        WX_CACHE = out;
        if (alive) setDays(out);
      } catch (e) { /* stay silent if the forecast can't load */ }
    })();
    return () => { alive = false; };
  }, []);
  if (!days || !days.length) return null;
  return (
    <div className="wx-card">
      <div className="wx-head">⛅ Lake forecast <span className="wx-note">updates daily</span></div>
      <div className="wx-row">
        {days.map((d, i) => (
          <div key={i} className="wx-day">
            <span className="wx-dow">{d.dow}</span>
            <span className="wx-icon">{d.icon}</span>
            <span className="wx-hi">{d.hi}°</span>
            <span className="wx-lo">{d.lo}°</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Shared party playlist. EMBED_SRC = Spotify's editorial "4th of July Party"
// playlist; swap in your own (a collaborative one lets the crew add songs).
const EMBED_SRC = 'https://open.spotify.com/embed/playlist/37i9dQZF1DX4nYqGKSH0ld?utm_source=generator&theme=0';
const ADD_URL = 'https://open.spotify.com/playlist/37i9dQZF1DX4nYqGKSH0ld';
const PLAYER_ALLOW = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';

// The party playlist card — same on every screen size, sits under the header.
function Playlist() {
  const addUrl = ADD_URL;
  return (
    <section className="playlist">
      <div className="playlist-head">🎵 Party playlist <span className="playlist-note">Cookout-tested, fireworks-approved 🎆</span></div>
      <div className="playlist-embed">
        <iframe src={EMBED_SRC} width="100%" height="152" loading="lazy" title="4th of July party playlist" allow={PLAYER_ALLOW} />
      </div>
      <a className="playlist-add" href={addUrl} target="_blank" rel="noreferrer">Open in Spotify ↗</a>
    </section>
  );
}

// Hidden fireworks reveal — embedded vertical Short, privacy-friendly nocookie host.
function FireworksEgg({ onClose }) {
  return (
    <div className="egg-overlay" onClick={onClose}>
      <div className="egg-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="egg-head">🎆 You found it · Happy 250th 🇺🇸</div>
        <div className="egg-video">
          <iframe
            src="https://www.youtube-nocookie.com/embed/jOTvjNBPZDo?autoplay=1&playsinline=1&rel=0"
            title="Fireworks" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen
          />
        </div>
        <button className="btn egg-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ---- Styles ------------------------------------------------------------------
function Style() {
  const topo = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cg fill='none' stroke='%23ffffff' stroke-width='1.2'%3E%3Cpath d='M-20 35 Q 40 8 80 35 T 180 35'/%3E%3Cpath d='M-20 70 Q 40 43 80 70 T 180 70'/%3E%3Cpath d='M-20 105 Q 40 78 80 105 T 180 105'/%3E%3Cpath d='M-20 140 Q 40 113 80 140 T 180 140'/%3E%3C/g%3E%3C/svg%3E";
  const starD = 'M0 -6L1.35 -1.86L5.71 -1.85L2.19 0.71L3.53 4.85L0 2.3L-3.53 4.85L-2.19 0.71L-5.71 -1.85L-1.35 -1.86Z';
  const stars = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Cg fill='%23ffffff'%3E%3Cpath transform='translate(22 26)' d='${starD}'/%3E%3Cpath transform='translate(82 42) scale(.8)' d='${starD}'/%3E%3Cpath transform='translate(52 86) scale(1.15)' d='${starD}'/%3E%3Cpath transform='translate(100 98) scale(.7)' d='${starD}'/%3E%3Cpath transform='translate(10 96) scale(.6)' d='${starD}'/%3E%3C/g%3E%3C/svg%3E`;
  return (
    <style>{`
html,body{margin:0;padding:0;width:100%;overflow-x:hidden}
.board{
  --pine:#243a63; --pine-2:#2f4c80; --moss:#35548c; --paper:#F4EFE4; --paper-2:#ECE4D3;
  --bark:#6B4F3A; --ink:#23291f; --lake:#2B6F8C; --lake-d:#205870; --ember:#D2792E; --line:#d9cfba;
  --flag-red:#b23a2f; --flag-navy:#2a3d5c; --flag-cream:#f6f1e6; --star:#e8b04b; --navy:#243a63; --navy-2:#152740;
  --sans:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;
  --disp:'Bricolage Grotesque',var(--sans);
  font-family:var(--sans); color:var(--ink); background:var(--paper);
  width:100%; max-width:560px; margin:0 auto; min-height:100vh; min-height:100dvh; overflow-x:hidden; -webkit-font-smoothing:antialiased;
}
.board *{box-sizing:border-box}
.board button{font-family:var(--sans); cursor:pointer}

.gate{min-height:100vh; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px;
  background:radial-gradient(120% 80% at 50% -10%, var(--pine-2), var(--pine) 60%);}
.gate-sign{background:var(--paper); border:2px solid var(--bark); border-radius:18px; padding:30px 26px; max-width:420px; width:100%;
  box-shadow:0 18px 50px rgba(0,0,0,.35), inset 0 0 0 6px var(--paper);}
.gate-title{font-family:var(--disp); font-weight:800; font-size:34px; line-height:1; margin:6px 0 12px; color:var(--pine); letter-spacing:-.02em}
.gate-title .amp{color:var(--ember)}
.gate-sub{font-size:14px; color:#5c5747; line-height:1.5; margin:0 0 18px}
.gate-row{display:flex; gap:8px}
.gate-input{flex:1}
.gate-people{display:flex; flex-wrap:wrap; gap:8px; margin:2px 0 14px}
.name-chip{background:var(--paper-2); border:1.5px solid var(--line); color:var(--pine); border-radius:11px; padding:10px 15px; font-family:var(--disp); font-weight:700; font-size:15px}
.name-chip:hover{border-color:var(--moss); background:#fff}
.gate-new-link{background:none; border:none; color:var(--lake-d); font-weight:600; font-size:13px; padding:6px 2px; text-decoration:underline}

.loading{min-height:100vh; min-height:100dvh; display:flex; flex-direction:column; gap:14px; align-items:center; justify-content:center; color:var(--moss); font-weight:600}
.spinner{width:30px; height:30px; border:3px solid var(--paper-2); border-top-color:var(--moss); border-radius:50%; animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.header{position:relative; background:linear-gradient(165deg,var(--navy),var(--navy-2)); color:#f3efe4; overflow:hidden; border-bottom:3px solid var(--bark)}
.topo{position:absolute; inset:0; background-image:url("${stars}"); background-size:120px 120px; opacity:.16; pointer-events:none}
.header-inner{position:relative; padding:18px 18px 20px}
.header-top{display:flex; justify-content:space-between; align-items:flex-start; gap:10px}
.eyebrow{font-family:var(--disp); text-transform:uppercase; letter-spacing:.16em; font-size:10px; font-weight:700; color:var(--moss)}
.eyebrow.light{color:#aebfd9}
.trip-title{font-family:var(--disp); font-weight:800; font-size:27px; line-height:1.02; margin:3px 0 0; letter-spacing:-.02em}
.trip-meta{font-size:12px; color:#aebfd9; margin-top:5px; font-weight:600}
.ghost-btn{background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.18); color:#f3efe4; border-radius:9px; padding:6px 9px; font-size:13px; line-height:1}

.whoami{margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap}
.whoami-sync{margin-left:auto}
.name-pill{background:rgba(255,255,255,.10); border:1px dashed rgba(255,255,255,.3); color:#e9e3d4; border-radius:20px; padding:5px 13px; font-size:12px}
.name-pill strong{color:#fff}
.name-input{max-width:170px}

.progress{margin-top:14px}
.progress-track{position:relative; height:8px; background:rgba(255,255,255,.14); border-radius:20px}
.progress-fill{height:100%; background:linear-gradient(90deg,var(--flag-red),#d4604c); border-radius:20px; transition:width .5s cubic-bezier(.4,0,.2,1)}
.progress-flag{position:absolute; top:-8px; width:16px; height:11px; border-left:2px solid var(--flag-cream); background:repeating-linear-gradient(180deg,var(--flag-red) 0 1.8px,var(--flag-cream) 1.8px 3.6px); box-shadow:0 1px 3px rgba(0,0,0,.4); transition:left .5s cubic-bezier(.4,0,.2,1)}
.progress-flag::before{content:''; position:absolute; left:2px; top:0; width:6px; height:5px; background:var(--flag-navy)}
.progress-label{font-size:11px; color:#aebfd9; margin-top:8px; font-weight:600; letter-spacing:.02em}
.usa250{display:inline-flex; align-items:center; gap:5px; margin-top:9px; background:rgba(244,239,228,.10); border:1px solid rgba(244,239,228,.22); color:#f1ead9; font-family:var(--disp); font-weight:800; font-size:9.5px; text-transform:uppercase; letter-spacing:.14em; padding:4px 10px; border-radius:7px}
.usa250 .star{color:var(--star); font-size:11px; line-height:1}
.flag-band{height:6px; width:100%; background:repeating-linear-gradient(90deg,var(--flag-red) 0 18px,var(--flag-cream) 18px 36px,var(--flag-navy) 36px 54px,var(--flag-cream) 54px 72px)}
.day-star{color:var(--star)}

.tabs{display:flex; position:sticky; top:0; z-index:4; background:var(--paper-2); border-bottom:1px solid var(--line)}
.tab{flex:1 1 0; min-width:0; background:none; border:none; padding:12px 4px; font-family:var(--disp); font-weight:700; font-size:13px; color:#8a8068; position:relative; display:flex; align-items:center; justify-content:center; gap:5px; white-space:nowrap}
.tab.on{color:var(--pine)}
.tab.on::after{content:''; position:absolute; bottom:-1px; left:14%; right:14%; height:3px; background:var(--flag-red); border-radius:3px}
.tab-count{background:rgba(0,0,0,.07); color:#6b6450; font-size:10px; font-weight:700; min-width:17px; height:17px; padding:0 4px; border-radius:11px; display:inline-flex; align-items:center; justify-content:center; font-family:var(--sans)}
.tab.on .tab-count{background:var(--moss); color:#fff}

.filter-bar{display:flex; gap:8px; padding:12px 14px 2px; align-items:center; flex-wrap:wrap}
.seg{display:inline-flex; background:var(--paper-2); border:1px solid var(--line); border-radius:10px; padding:3px; gap:2px}
.seg-btn{border:none; background:none; padding:6px 11px; border-radius:8px; font-size:12.5px; font-weight:700; color:#8a8068; display:inline-flex; align-items:center; gap:5px}
.seg-btn.on{background:#fff; color:var(--pine); box-shadow:0 1px 3px rgba(0,0,0,.08)}
.seg-count{background:rgba(0,0,0,.08); color:#6b6450; font-size:10.5px; min-width:16px; height:16px; padding:0 5px; border-radius:9px; display:inline-flex; align-items:center; justify-content:center}
.seg-btn.on .seg-count{background:var(--moss); color:#fff}
.search{position:relative; flex:1; min-width:150px}
.search .input{width:100%; padding-right:30px}
.search-clear{position:absolute; right:6px; top:50%; transform:translateY(-50%); background:none; border:none; color:#b3a890; font-size:18px; line-height:1; padding:2px 6px}
.copy-btn{background:var(--lake); color:#fff; padding:8px 13px; flex:0 0 auto}
.copy-btn:hover{filter:brightness(1.07)}
.copy-btn.copied{background:var(--moss)}
.copy-fallback{position:fixed; inset:0; background:rgba(27,58,43,.55); display:flex; align-items:flex-end; justify-content:center; z-index:50; padding:14px}
.copy-sheet{background:var(--paper); border:1px solid var(--bark); border-radius:16px; padding:16px; width:100%; max-width:460px; display:flex; flex-direction:column; gap:10px; box-shadow:0 -10px 40px rgba(0,0,0,.3)}
.copy-sheet-head{font-family:var(--disp); font-weight:700; font-size:14px; color:var(--pine)}
.copy-text{width:100%; min-height:160px; border:1px solid var(--line); border-radius:10px; padding:11px; font-family:var(--sans); font-size:16px; color:var(--ink); background:#fff; resize:none}
.egg-overlay{position:fixed; inset:0; background:rgba(12,20,40,.82); display:flex; align-items:center; justify-content:center; z-index:60; padding:16px; overflow:auto}
.egg-sheet{background:var(--navy); border:1px solid rgba(255,255,255,.16); border-radius:18px; padding:14px; width:min(90vw,340px); margin:auto; display:flex; flex-direction:column; gap:12px; box-shadow:0 26px 80px rgba(0,0,0,.55)}
.egg-head{font-family:var(--disp); font-weight:800; font-size:15px; color:#fff; text-align:center}
.egg-video{position:relative; width:100%; aspect-ratio:9/16; max-height:74vh; border-radius:12px; overflow:hidden; background:#000}
.egg-video iframe{position:absolute; inset:0; width:100%; height:100%; border:0}
.egg-close{background:var(--flag-cream); color:var(--navy)}
.join-hint{margin-top:4px; padding:12px 14px; background:rgba(43,111,140,.07); border:1px solid rgba(43,111,140,.25); border-radius:12px; font-size:12.5px; line-height:1.5; color:#3a5360}
.join-hint strong{color:var(--lake-d)}
.event-meta{font-size:12px; color:var(--lake-d); font-weight:600}
.going-names{font-size:11.5px; color:#8a8068}
.events-add{flex-wrap:wrap}
.source-note{margin-top:6px; padding:11px 13px; font-size:11.5px; line-height:1.5; color:#9a8f76; background:var(--paper-2); border:1px dashed var(--line); border-radius:11px}
.source-note a{color:var(--lake-d); font-weight:600}
.wx-card{background:var(--paper-2); border:1px dashed var(--line); border-radius:12px; padding:10px 11px; display:flex; flex-direction:column; gap:8px}
.wx-head{font-family:var(--disp); font-weight:800; font-size:12px; color:var(--navy); display:flex; align-items:baseline; gap:7px; flex-wrap:wrap}
.wx-note{font-family:var(--sans); font-weight:500; font-size:10.5px; color:#9a8f76}
.wx-row{display:flex; gap:6px}
.wx-day{flex:1; min-width:0; background:#fff; border:1px solid var(--line); border-radius:10px; padding:7px 2px; display:flex; flex-direction:column; align-items:center; gap:1px}
.wx-dow{font-family:var(--disp); font-weight:700; font-size:10px; text-transform:uppercase; letter-spacing:.03em; color:var(--bark)}
.wx-icon{font-size:17px; line-height:1.2}
.wx-hi{font-weight:700; font-size:12.5px; color:var(--ink)}
.wx-lo{font-size:11px; color:#9a8f76}

.content{padding:12px 14px 8px}
.section{display:flex; flex-direction:column; gap:14px}
.day-block{display:flex; flex-direction:column; gap:7px}
.day-head{font-family:var(--disp); text-transform:uppercase; letter-spacing:.12em; font-size:11px; font-weight:700; color:var(--bark); padding:2px 2px 1px; border-bottom:1.5px solid var(--line)}

.row{display:flex; align-items:center; justify-content:space-between; gap:10px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:11px 13px; transition:background .25s, border-color .25s, transform .08s}
.row:active{transform:scale(.995)}
.row.claimed{background:linear-gradient(0deg,rgba(43,111,140,.06),rgba(43,111,140,.06)),#fff; border-color:rgba(43,111,140,.35)}
.row.got{background:linear-gradient(0deg,rgba(36,58,99,.08),rgba(36,58,99,.08)),#fff; border-color:rgba(36,58,99,.42)}
.row.meal.big{border-color:var(--ember); box-shadow:0 0 0 1px var(--ember) inset}
.row-main{display:flex; flex-direction:column; gap:3px; min-width:0}
.slot{font-family:var(--disp); font-weight:700; font-size:15px; color:var(--ink); display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.item-name{font-weight:600; font-size:14px; color:var(--ink); display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.owner{font-size:12px; color:var(--lake-d); font-weight:600}
.menu-text{font-size:12.5px; color:var(--bark); font-weight:600}
.menu-input{margin-top:3px; width:100%; border:1px solid var(--line); border-radius:8px; padding:6px 9px; font-size:16px; font-family:var(--sans); color:var(--ink); background:#fff; outline:none}
.menu-input:focus{border-color:var(--lake)}
.menu-input::placeholder{color:#b3a890; font-size:13px}
.sides{display:flex; flex-wrap:wrap; gap:5px; margin-top:4px}
.side-chip{display:inline-flex; align-items:center; gap:3px; font-size:11.5px; font-weight:600; color:var(--moss); background:rgba(53,84,140,.08); border:1px solid rgba(53,84,140,.2); border-radius:8px; padding:2px 4px 2px 8px}
.side-x{background:none; border:none; color:#9a8f76; font-size:15px; line-height:1; padding:0 3px; margin-left:1px}
.side-x:hover{color:#b04a2e}
.side-input{margin-top:4px}
.add-side{align-self:flex-start; margin-top:5px; background:none; border:1px dashed var(--line); color:var(--lake-d); font-size:11.5px; font-weight:600; border-radius:8px; padding:4px 9px}
.add-side:hover{border-color:var(--lake); color:var(--lake)}
.notes{font-size:12px; color:#8a8068}
.qty-tag{font-size:11px; background:var(--paper-2); color:var(--bark); padding:1px 7px; border-radius:8px; font-weight:600}
.badge{font-family:var(--sans); font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; background:var(--ember); color:#fff; padding:2px 7px; border-radius:7px; font-weight:700}
.row-actions{display:flex; align-items:center; gap:6px; flex-shrink:0}

.btn{border:none; border-radius:9px; padding:8px 13px; font-size:13px; font-weight:700; transition:filter .15s, opacity .15s}
.btn:disabled{opacity:.5; cursor:default}
.btn.claim{background:var(--lake); color:#fff}
.btn.claim:hover{filter:brightness(1.07)}
.btn.primary{background:var(--pine); color:#fff}
.btn.primary:hover{filter:brightness(1.12)}
.btn.ghost{background:transparent; color:#9a8f76; border:1px solid var(--line); padding:7px 11px}
.btn.ghost:hover{color:var(--bark); border-color:var(--bark)}
.btn.tiny{padding:5px 10px; font-size:12px; background:var(--moss); color:#fff}
.chip{background:#fff; border:1px solid var(--line); color:#8a8068; border-radius:8px; padding:6px 10px; font-size:12px; font-weight:600}
.chip.on{background:var(--moss); border-color:var(--moss); color:#fff}
.x{background:none; border:none; color:#c3b9a3; font-size:18px; line-height:1; padding:6px 9px; margin:-4px -3px -4px 0}
.x:hover{color:#b04a2e}

.add-card{display:flex; gap:7px; background:var(--paper-2); border:1px dashed var(--line); border-radius:12px; padding:9px}
.input{border:1px solid var(--line); border-radius:9px; padding:9px 11px; font-size:16px; font-family:var(--sans); background:#fff; color:var(--ink); min-width:0; flex:1; outline:none}
.input:focus{border-color:var(--lake)}
.input.qty{max-width:78px; flex:0 0 auto}
.input.select{flex:0 0 auto; max-width:150px}
.input.wide{width:100%; flex:1; max-width:none}

.you-card{background:#fff; border:1px solid rgba(43,111,140,.35); border-radius:14px; padding:14px; display:flex; flex-direction:column; gap:12px}
.you-head{font-family:var(--disp); font-weight:800; font-size:15px; color:var(--lake-d)}
.field{display:flex; flex-direction:column; gap:6px}
.field label{font-size:12px; font-weight:600; color:#8a8068}
.roster-summary{font-family:var(--disp); font-weight:700; font-size:14px; color:var(--pine)}
.stepper{display:inline-flex; align-items:center; gap:0; border:1px solid var(--line); border-radius:10px; overflow:hidden; align-self:flex-start}
.stepper button{width:40px; height:38px; border:none; background:var(--paper-2); font-size:20px; color:var(--bark); line-height:1}
.stepper button:hover{background:#e3d9c5}
.stepper span{min-width:46px; text-align:center; font-weight:700; font-size:15px; color:var(--ink)}
.person-row{display:flex; align-items:center; justify-content:space-between; background:#fff; border:1px solid var(--line); border-radius:12px; padding:11px 13px}
.person-meta{font-size:12px; color:#8a8068}

.empty{padding:26px 16px; text-align:center; font-size:13px; color:#9a8f76; background:#fff; border:1px dashed var(--line); border-radius:12px}

.sync{display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600}
.sync-dot{width:7px; height:7px; border-radius:50%; background:#9fb4d4}
.sync-saving .sync-dot{background:var(--ember); animation:pulse 1s infinite}
.sync-error .sync-dot{background:#e0573a}
@keyframes pulse{50%{opacity:.3}}

.playlist{margin:13px 14px 16px; padding:12px 13px; background:var(--paper-2); border:1px solid var(--line); border-radius:14px; display:flex; flex-direction:column; gap:9px}
.playlist-head{font-family:var(--disp); font-weight:800; font-size:13px; color:var(--navy); display:flex; align-items:center; gap:6px; flex-wrap:wrap}
.playlist-note{font-family:var(--sans); font-weight:500; font-size:11px; color:#9a8f76}
.playlist-embed{border-radius:12px; overflow:hidden; line-height:0}
.playlist-embed iframe{display:block; border:0}
.playlist-add{font-size:12px; color:var(--lake-d); font-weight:600; text-decoration:none}
.playlist-add:hover{text-decoration:underline}
.foot{padding:16px 18px 26px; font-size:11.5px; color:#9a8f76; text-align:center; line-height:1.5}
.mode-banner{margin:12px 14px 0; padding:10px 13px; background:rgba(210,121,46,.10); border:1px solid rgba(210,121,46,.4); border-radius:11px; font-size:12px; line-height:1.45; color:#7a4a1f}
.mode-banner strong{color:var(--ember)}
.app{padding-bottom:8px}

@media (prefers-reduced-motion: reduce){ .board *{animation:none !important; transition:none !important} }

/* ---- Desktop: float the board as a panel on a night-sky backdrop ----
   Scoped with :has(.app) so the full-bleed check-in gate and loading screen
   keep their edge-to-edge treatment; only the live board gets framed. */
@media (min-width: 620px){
  /* Literal hex (not var()): body is the PARENT of .board, so it can't
     inherit the color vars declared there — var() here would void the gradient. */
  body{ background:radial-gradient(125% 90% at 50% -10%, #243a63, #152740 60%, #0e1830 100%) fixed; }
  /* Faint starfield behind the floating board (live app only, not the gate). */
  body:has(.app)::before{ content:''; position:fixed; inset:0; z-index:0; pointer-events:none; background:url("${stars}") 0 0/200px 200px; opacity:.08 }
  .board:has(.app){
    position:relative; z-index:1;
    max-width:600px; min-height:auto; margin:34px auto 48px;
    border-radius:20px; box-shadow:0 28px 70px rgba(0,0,0,.42), 0 6px 18px rgba(0,0,0,.22);
  }
  .board:has(.app) .header{ border-top-left-radius:20px; border-top-right-radius:20px }
  .board:has(.app) .foot{ border-bottom-left-radius:20px; border-bottom-right-radius:20px }
}
/* Mouse-only hover affordances (suppressed on touch so taps don't sticky-hover). */
@media (hover:hover) and (min-width:620px){
  .row:hover{ border-color:#cabfa6 }
  .row.claimed:hover{ border-color:rgba(43,111,140,.5) }
  .row.got:hover{ border-color:rgba(36,58,99,.55) }
}
    `}</style>
  );
}
