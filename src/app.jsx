import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Shared Board — a no-login multiplayer board on Cloudflare Workers + KV.
 *
 * A tabbed board with five sections, each backed by one KV key:
 *   Potluck / Supplies / Gear  — claimable item lists (claim, release, filter, search)
 *   Guests                     — RSVP headcount (name, party size, arrival)
 *   Schedule                   — day-keyed events with "who's going" RSVPs
 *
 * Every edit is read-merge-write against the LATEST server copy of a section, so
 * concurrent edits to different rows are safe (same-row edits within a second are
 * last-write-wins — fine at small-group scale; use a Durable Object for true
 * atomicity). The board polls every few seconds so everyone sees each other's
 * changes without a refresh. Identity is just a display name in localStorage.
 *
 * Themed here for a 4th of July cookout — restyle in public/index.html.
 */

// Optional shared secret. If you set BOARD_KEY in wrangler.toml, put the same
// value here (or inject it at build time) so writes are accepted.
const BOARD_KEY = '';

// One KV key per section. Keep in sync with SECTIONS in worker.js (for backups).
const SECTIONS = {
  potluck: 'board:potluck:v1',
  supplies: 'board:supplies:v1',
  gear: 'board:gear:v1',
  guests: 'board:guests:v1',
  events: 'board:events:v1',
};

const TAB_ORDER = ['potluck', 'supplies', 'gear', 'guests', 'events'];
const TAB_LABEL = { potluck: 'Potluck', supplies: 'Supplies', gear: 'Gear', guests: 'Guests', events: 'Schedule' };

const CLAIM_META = {
  potluck: 'Add a dish to bring…',
  supplies: 'Add a supply — ice, plates, drinks…',
  gear: 'Add gear — grill, chairs, cooler, games…',
};

const api = {
  async get(key) {
    const res = await fetch(`/api/kv/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${key} → ${res.status}`);
    return res.json();
  },
  async put(key, value) {
    const res = await fetch(`/api/kv/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(BOARD_KEY && { 'x-board-key': BOARD_KEY }) },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`PUT ${key} → ${res.status}`);
  },
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

// Stable per-browser id, used for claim ownership and RSVPs (survives name changes).
function getPid() {
  let p = localStorage.getItem('board:pid');
  if (!p) { p = uid(); localStorage.setItem('board:pid', p); }
  return p;
}

// Loads all sections, polls them, and exposes mutate(section, fn) that applies an
// edit to the freshest server copy before writing it back.
function useBoard() {
  const empty = { potluck: [], supplies: [], gear: [], guests: [], events: [] };
  const [data, setData] = useState(empty);
  const [loaded, setLoaded] = useState(false);
  const busy = useRef(false);

  async function refresh() {
    if (busy.current) return; // don't let a poll clobber an in-flight local edit
    const keys = Object.keys(SECTIONS);
    const vals = await Promise.all(keys.map((k) => api.get(SECTIONS[k])));
    const next = {};
    keys.forEach((k, i) => { next[k] = Array.isArray(vals[i]) ? vals[i] : []; });
    setData(next);
    setLoaded(true);
  }

  useEffect(() => {
    refresh().catch(console.error);
    const t = setInterval(() => refresh().catch(console.error), 6000);
    return () => clearInterval(t);
  }, []);

  async function mutate(section, fn) {
    busy.current = true;
    try {
      const latest = (await api.get(SECTIONS[section])) || [];
      const nextArr = fn(Array.isArray(latest) ? latest : []);
      setData((d) => ({ ...d, [section]: nextArr }));
      await api.put(SECTIONS[section], nextArr);
    } finally {
      busy.current = false;
    }
  }

  return { data, loaded, mutate };
}

function ClaimList({ section, items, me, myId, mutate }) {
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');

  const edit = (fn) => mutate(section, fn).catch(console.error);
  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    edit((a) => [...a, { id: uid(), text: t, owner: '', ownerId: '' }]);
  };
  const claim = (id) => edit((a) => a.map((x) => (x.id === id ? { ...x, owner: me, ownerId: myId } : x)));
  const release = (id) =>
    edit((a) => a.map((x) => (x.id === id && x.ownerId === myId ? { ...x, owner: '', ownerId: '' } : x)));
  const remove = (id) => edit((a) => a.filter((x) => x.id !== id));

  const shown = items.filter((x) => {
    if (filter === 'mine' && x.ownerId !== myId) return false;
    if (filter === 'open' && x.owner) return false;
    if (q && !x.text.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <section className="card">
      <div className="add">
        <input
          value={text}
          placeholder={CLAIM_META[section]}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button onClick={add}>Add</button>
      </div>
      <div className="toolbar">
        <div className="filters">
          {['all', 'mine', 'open'].map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'mine' ? 'Mine' : 'Open'}
            </button>
          ))}
        </div>
        <input className="search" value={q} placeholder="Search…" onChange={(e) => setQ(e.target.value)} />
      </div>
      {shown.length === 0 ? (
        <p className="muted">{items.length === 0 ? 'Nothing here yet — add the first item.' : 'No matches.'}</p>
      ) : (
        <ul className="rows">
          {shown.map((x) => (
            <li key={x.id} className={x.owner ? 'claimed' : ''}>
              <span className="what">{x.text}</span>
              {x.owner ? (
                <>
                  <span className="by">{x.ownerId === myId ? 'you' : x.owner}</span>
                  {x.ownerId === myId && (
                    <button className="link" onClick={() => release(x.id)}>release</button>
                  )}
                </>
              ) : (
                <button className="mini" onClick={() => claim(x.id)}>I'll bring it</button>
              )}
              <button className="del" onClick={() => remove(x.id)} aria-label="Delete">×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Guests({ items, me, myId, mutate }) {
  const mine = items.find((g) => g.personId === myId);
  const [party, setParty] = useState(1);
  const [arrival, setArrival] = useState('');

  useEffect(() => {
    if (mine) { setParty(mine.party || 1); setArrival(mine.arrival || ''); }
  }, [mine?.id]);

  const save = () =>
    mutate('guests', (a) => {
      const others = a.filter((g) => g.personId !== myId);
      return [...others, { id: mine?.id || uid(), personId: myId, name: me, party: Number(party) || 1, arrival }];
    }).catch(console.error);
  const removeMe = () => mutate('guests', (a) => a.filter((g) => g.personId !== myId)).catch(console.error);

  const heads = items.reduce((n, g) => n + (Number(g.party) || 0), 0);

  return (
    <section className="card">
      <div className="guest-form">
        <label>
          Party size
          <input type="number" min="1" value={party} onChange={(e) => setParty(e.target.value)} />
        </label>
        <label>
          Arriving
          <input value={arrival} placeholder="e.g. Fri evening" onChange={(e) => setArrival(e.target.value)} />
        </label>
        <button onClick={save}>{mine ? 'Update my RSVP' : "I'm in"}</button>
        {mine && <button className="link" onClick={removeMe}>remove</button>}
      </div>
      <p className="total">
        <strong>{heads}</strong> {heads === 1 ? 'head' : 'heads'} across {items.length} {items.length === 1 ? 'party' : 'parties'}
      </p>
      {items.length === 0 ? (
        <p className="muted">No one's RSVP'd yet.</p>
      ) : (
        <ul className="rows">
          {items.map((g) => (
            <li key={g.id}>
              <span className="what">{g.name}{g.personId === myId ? ' (you)' : ''}</span>
              <span className="by">party of {g.party}{g.arrival ? ` · ${g.arrival}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Schedule({ items, myId, mutate }) {
  const blank = { title: '', day: '', time: '', place: '', note: '' };
  const [form, setForm] = useState(blank);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const addEvent = () => {
    if (!form.title.trim()) return;
    const item = { id: uid(), going: [], ...form, title: form.title.trim() };
    setForm(blank);
    mutate('events', (a) => [...a, item]).catch(console.error);
  };
  const toggleGoing = (id) =>
    mutate('events', (a) =>
      a.map((e) => {
        if (e.id !== id) return e;
        const going = e.going || [];
        return { ...e, going: going.includes(myId) ? going.filter((x) => x !== myId) : [...going, myId] };
      }),
    ).catch(console.error);
  const remove = (id) => mutate('events', (a) => a.filter((e) => e.id !== id)).catch(console.error);

  // Group by day, preserving first-seen day order.
  const days = [];
  const byDay = {};
  for (const e of items) {
    const d = e.day || 'Anytime';
    if (!byDay[d]) { byDay[d] = []; days.push(d); }
    byDay[d].push(e);
  }

  return (
    <section className="card">
      <div className="event-form">
        <input value={form.title} placeholder="Event…" onChange={(e) => set('title', e.target.value)} />
        <div className="event-form-row">
          <input value={form.day} placeholder="Day (e.g. Jul 4)" onChange={(e) => set('day', e.target.value)} />
          <input value={form.time} placeholder="Time" onChange={(e) => set('time', e.target.value)} />
        </div>
        <div className="event-form-row">
          <input value={form.place} placeholder="Place" onChange={(e) => set('place', e.target.value)} />
          <button onClick={addEvent}>Add event</button>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="muted">No events yet — add the first one.</p>
      ) : (
        days.map((d) => (
          <div key={d} className="day">
            <h3 className="day-head">{d}</h3>
            <ul className="rows">
              {byDay[d].map((e) => {
                const going = e.going || [];
                const iam = going.includes(myId);
                return (
                  <li key={e.id} className="event">
                    <div className="event-main">
                      <span className="what">{e.title}</span>
                      <span className="by">
                        {[e.time, e.place].filter(Boolean).join(' · ')}
                        {e.note ? ` — ${e.note}` : ''}
                      </span>
                    </div>
                    <button className={`mini ${iam ? 'on' : ''}`} onClick={() => toggleGoing(e.id)}>
                      {iam ? '✓ Going' : 'Going?'} {going.length > 0 && <span className="count">{going.length}</span>}
                    </button>
                    <button className="del" onClick={() => remove(e.id)} aria-label="Delete">×</button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function tabCount(key, data) {
  if (key === 'guests') return data.guests.reduce((n, g) => n + (Number(g.party) || 0), 0);
  if (key === 'events') return data.events.length;
  return data[key].filter((x) => !x.owner).length; // open (unclaimed) items
}

function App() {
  const [me, setMe] = useState(() => localStorage.getItem('board:name') || '');
  const [myId] = useState(getPid);
  const [tab, setTab] = useState('potluck');
  const { data, loaded, mutate } = useBoard();

  if (!me) {
    return (
      <div className="gate">
        <h1>🎆 4th of July Board</h1>
        <p className="muted">Pick a display name so others know who's editing.</p>
        <NamePrompt onSet={(n) => { localStorage.setItem('board:name', n); setMe(n); }} />
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <h1>🎆 4th of July Board</h1>
        <span className="me">
          {me}{' '}
          <button className="link" onClick={() => { localStorage.removeItem('board:name'); setMe(''); }}>change</button>
        </span>
      </header>

      <nav className="tabs">
        {TAB_ORDER.map((k) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {TAB_LABEL[k]}
            {loaded && <span className="tab-count">{tabCount(k, data)}</span>}
          </button>
        ))}
      </nav>

      <main>
        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : tab === 'guests' ? (
          <Guests items={data.guests} me={me} myId={myId} mutate={mutate} />
        ) : tab === 'events' ? (
          <Schedule items={data.events} myId={myId} mutate={mutate} />
        ) : (
          <ClaimList section={tab} items={data[tab]} me={me} myId={myId} mutate={mutate} />
        )}
      </main>

      <footer className="muted">
        No login — everyone with this link shares the same board. Happy 4th! 🇺🇸 Built on Cloudflare Workers + KV.
      </footer>
    </>
  );
}

function NamePrompt({ onSet }) {
  const [v, setV] = useState('');
  return (
    <div className="add">
      <input
        value={v}
        placeholder="Your name…"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && v.trim() && onSet(v.trim())}
        autoFocus
      />
      <button onClick={() => v.trim() && onSet(v.trim())}>Start</button>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
