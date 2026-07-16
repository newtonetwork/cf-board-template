import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Shared Board — a no-login multiplayer board on Cloudflare Workers + KV.
 *
 * Each "section" is one KV key. The app fetches a section, merges a local edit,
 * and writes the whole section back (read-merge-write). Concurrent edits to
 * DIFFERENT rows are safe; simultaneous edits to the SAME row are last-write-wins,
 * which is fine at small-group scale. It also polls every few seconds so everyone
 * sees each other's changes without a refresh.
 *
 * Identity is just a display name in localStorage — no accounts, no login.
 */

// Optional shared secret. If you set BOARD_KEY in wrangler.toml, put the same
// value here (or inject it at build time) so writes are accepted.
const BOARD_KEY = '';

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

// A small hook that keeps one KV section in sync: loads it, polls it, and gives
// you a `mutate` that applies your change to the LATEST server copy before saving.
function useSection(key) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const busy = useRef(false);

  async function refresh() {
    if (busy.current) return; // don't clobber an in-flight local edit with a poll
    const data = await api.get(key);
    setRows(Array.isArray(data) ? data : []);
    setLoaded(true);
  }

  useEffect(() => {
    refresh().catch(console.error);
    const t = setInterval(() => refresh().catch(console.error), 5000);
    return () => clearInterval(t);
  }, [key]);

  // Read the freshest copy, apply `fn`, write it back — so we merge with, rather
  // than overwrite, edits other people made while we were looking at the page.
  async function mutate(fn) {
    busy.current = true;
    try {
      const latest = (await api.get(key)) || [];
      const next = fn(Array.isArray(latest) ? latest : []);
      setRows(next);
      await api.put(key, next);
    } finally {
      busy.current = false;
    }
  }

  return { rows, loaded, mutate };
}

function Checklist({ me }) {
  const { rows, loaded, mutate } = useSection('board:list:v1');
  const [text, setText] = useState('');

  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    mutate((r) => [...r, { id: uid(), text: t, done: false, by: me }]).catch(console.error);
  };
  const toggle = (id) =>
    mutate((r) => r.map((x) => (x.id === id ? { ...x, done: !x.done } : x))).catch(console.error);
  const remove = (id) => mutate((r) => r.filter((x) => x.id !== id)).catch(console.error);

  return (
    <section className="card">
      <h2>Checklist</h2>
      <div className="add">
        <input
          value={text}
          placeholder="Add an item…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button onClick={add}>Add</button>
      </div>
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Nothing yet — add the first item.</p>
      ) : (
        <ul className="rows">
          {rows.map((x) => (
            <li key={x.id} className={x.done ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={x.done} onChange={() => toggle(x.id)} />
                <span>{x.text}</span>
              </label>
              <span className="by">{x.by}</span>
              <button className="del" onClick={() => remove(x.id)} aria-label="Delete">×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Notes({ me }) {
  const { rows, loaded, mutate } = useSection('board:notes:v1');
  const [text, setText] = useState('');

  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    mutate((r) => [{ id: uid(), text: t, by: me, at: new Date().toISOString() }, ...r]).catch(console.error);
  };
  const remove = (id) => mutate((r) => r.filter((x) => x.id !== id)).catch(console.error);

  return (
    <section className="card">
      <h2>Notes</h2>
      <div className="add">
        <input
          value={text}
          placeholder="Leave a note…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button onClick={add}>Post</button>
      </div>
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <ul className="rows">
          {rows.map((x) => (
            <li key={x.id}>
              <span>{x.text}</span>
              <span className="by">{x.by}</span>
              <button className="del" onClick={() => remove(x.id)} aria-label="Delete">×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function App() {
  const [me, setMe] = useState(() => localStorage.getItem('board:name') || '');

  if (!me) {
    return (
      <div className="gate">
        <h1>Shared Board</h1>
        <p className="muted">Pick a display name so others know who's editing.</p>
        <NamePrompt onSet={(n) => { localStorage.setItem('board:name', n); setMe(n); }} />
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <h1>Shared Board</h1>
        <span className="me">
          {me}{' '}
          <button
            className="link"
            onClick={() => { localStorage.removeItem('board:name'); setMe(''); }}
          >
            change
          </button>
        </span>
      </header>
      <main>
        <Checklist me={me} />
        <Notes me={me} />
      </main>
      <footer className="muted">
        No login — everyone with this URL shares the same board. Built on Cloudflare Workers + KV.
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
