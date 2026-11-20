// What the person types is never lost: the composer and every question's Other box are kept per thread and per question in localStorage, so a poll, a withdrawal, a re-ask, a merge, a move
// or a reload cannot take it. Every storage call is wrapped: a browser that blocks storage just forgets on reload, as before. No build, no deps.
export const DRAFT_KEY = 'fb-inbox-drafts';
const MAX_ENTRIES = 200;
const MAX_TEXT = 12000;

export const composerKey = (project, thread) => `${project || 'default'}|${thread}|c`;
export const questionKey = (project, thread, qid) => `${project || 'default'}|${thread}|q:${qid}`;

export function createDrafts(storage = () => globalThis.localStorage, now = () => Date.now()) {
  const load = () => {
    try { const v = JSON.parse(storage().getItem(DRAFT_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
  };
  const save = all => {
    try {
      const keys = Object.keys(all);
      if (keys.length > MAX_ENTRIES) for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - MAX_ENTRIES)) delete all[k];
      storage().setItem(DRAFT_KEY, JSON.stringify(all));
    } catch { /* storage may be blocked or full */ }
  };
  return {
    get(key) { const v = load()[key]; return v && typeof v.t === 'string' ? v.t : ''; },
    set(key, text) {
      const all = load();
      if (typeof text !== 'string' || !text.trim()) { if (key in all) { delete all[key]; save(all); } return; }
      if (all[key]?.t === text) return;
      all[key] = { t: text.slice(0, MAX_TEXT), at: now() };
      save(all);
    },
    clear(key) { const all = load(); if (key in all) { delete all[key]; save(all); } },
    // Every draft of one thread's questions: [{ qid, text }].
    questions(project, thread) {
      const prefix = `${project || 'default'}|${thread}|q:`;
      return Object.entries(load()).filter(([k, v]) => k.startsWith(prefix) && v && typeof v.t === 'string').map(([k, v]) => ({ qid: k.slice(prefix.length), text: v.t }));
    },
    // A thread that moved to another project (and maybe another id) takes its drafts along.
    move(from, to) {
      const all = load(); let changed = false;
      for (const k of Object.keys(all)) {
        if (!k.startsWith(`${from.project || 'default'}|${from.thread}|`)) continue;
        const next = `${to.project || 'default'}|${to.thread}|${k.split('|').slice(2).join('|')}`;
        if (next !== k) { all[next] = all[k]; delete all[k]; changed = true; }
      }
      if (changed) save(all);
    },
  };
}

// Tells the server the person is typing in a thread: the first keystroke after a pause is sent a moment later (debounced), then at most one ping per `gap` while typing goes on.
// The server forgets it ~15 seconds after the last ping, so a stop is only sent to say "done" early (after a send, or an emptied box).
export function typingPinger({ send, gap = 5000, delay = 300, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = t => clearTimeout(t), now = () => Date.now() }) {
  let timer = null, last = -Infinity, on = false;
  return {
    note() {
      if (timer !== null || now() - last < gap) return;
      timer = setTimer(() => { timer = null; last = now(); on = true; send(true); }, delay);
    },
    stop() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (on) { on = false; last = -Infinity; send(false); }
    },
  };
}
