// Feedback inbox. No build, no deps. All text goes through textContent; nothing is injected as HTML.
import { DEFAULT_AREAS, areaLabel, areaOf, sortAreas, subHeading } from './areas.js';
import { isReplySwipe, resolveQuote, snippetOf } from './quote.js';
import { donutLabel, donutNode } from './donut.js';
import { asideGroups, isAside, parseBtw } from './aside.js';
import { ageOf, filterRows, stateOf } from './tracker.js';
import { firstPlainLine, inline, markdown, plainText } from './markdown.js';
import { secretStatusLine, secretUrl } from './secret.js';
import { createOutbox, newCid } from './outbox.js';
export { inline, markdown };
const API = new URL('../api/', location.href).pathname;
const POLL_MS = 10000;
const MAX_IMAGES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const $ = id => document.getElementById(id);

const FOLD_KEY = 'fb-inbox-folds';
const CL_KEY = 'fb-inbox-checklist';
const state = { trackerOn: false, tdata: null, tdrawn: '', tfilter: { thread: '', state: '', q: '' }, tDoneOpen: true, focusItem: null, metricsOn: false, mwindow: '7d', mdata: null, mdrawn: '', threads: [], filter: 'all', pins: { threads: [], areas: [] }, areaConfig: DEFAULT_AREAS, expanded: new Set(), clPref: loadClPref(), sheet: false, clOwner: 'agent', clEdit: null, clShown: '', msgStop: null,
  view: null, q: '', replyTo: null, asideOpen: new Map(), openId: null, detail: null, shown: '', images: [], newImages: [], busy: false,
  config: null, offline: false, secrets: new Map(), replacing: new Set(), echo: new Map(), atBottom: true, redactFor: null,
  profile: { user: { name: 'You' }, agent: { name: 'Agent' } }, order: [], gallery: [], galleryAt: 0, qsel: {}, folds: loadFolds() };
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function loadFolds() { try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function loadClPref() { try { const v = JSON.parse(localStorage.getItem(CL_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function saveClPref() { try { localStorage.setItem(CL_KEY, JSON.stringify(state.clPref)); } catch { /* storage may be blocked */ } }
function saveFolds() { try { localStorage.setItem(FOLD_KEY, JSON.stringify(state.folds)); } catch { /* storage may be blocked */ } }

// A request that got no answer at all is a NetworkError (`network: true`): the inbox goes offline-aware instead of showing a failure.
async function api(path, options) {
  let response;
  try { response = await fetch(API + path, options); }
  catch { setOffline(true); const e = new Error("You're offline, or the server can't be reached."); e.network = true; throw e; }
  setOffline(!!response.headers?.get?.('X-Fb-Offline')); // the service worker marks a saved copy it served in place of the network
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail || ''; } catch { /* not JSON */ }
    throw new Error(detail || (response.status === 413 ? 'That is too large to send.' : `Request failed (${response.status})`));
  }
  return response.json();
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fileUrl = (id, name) => `${API}items/${id}/${name}`;
const noop = () => {};
const isOffline = () => state.offline || navigator.onLine === false;
function setOffline(value) { if (state.offline === value) return; state.offline = value; drawOffline(); if (state.detail) drawMessages(state.detail); if (!value) outbox.flush(); } // back from offline: send what waited, even with no online event (a server restart)
const COARSE = !!matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
const isPhone = () => !!matchMedia?.('(max-width: 759px)')?.matches;
const sentTitle = m => (m.written_at && Math.abs(Date.parse(m.created_at) - Date.parse(m.written_at)) > 60000 ? { title: `Written offline, sent ${when(m.created_at)}` } : {});
const lockedText = m => `🔒 Redacted (sensitive) · ${when(m.redacted.at)} · by ${state.profile[m.redacted.by]?.name || 'someone'}`;
const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value; else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value);
  }
  node.append(...kids);
  return node;
}

// ---- Keycaps: <kbd data-keys="mod+K"> shows ⌘K on a Mac and Ctrl+K elsewhere.
function keyLabel(keys) {
  return keys.split('+').map(k => (k === 'mod' ? (IS_MAC ? '⌘' : 'Ctrl') : k === 'Enter' ? '↵' : k)).join(IS_MAC ? '' : '+');
}
function paintKeys(root = document) { for (const k of root.querySelectorAll('kbd[data-keys]')) k.textContent = keyLabel(k.dataset.keys); }
const kbd = keys => el('kbd', { 'data-keys': keys, text: keyLabel(keys) });
const SHORTCUTS = [
  ['mod+Enter', 'Send the message (or start the thread)'], ['mod+I', 'Attach an image'], ['mod+V', 'Paste an image'], ['mod+K', 'Search threads'],
  ['J / ↓', 'Next thread'], ['K / ↑', 'Previous thread'], ['E', 'Mark the open thread done, or reopen it'], ['N', 'New thread'], ['P', 'Pin or unpin the open thread'],
  ['C', 'Add a checklist item for the agent'], ['Y', 'Add a checklist item for you'], ['L', 'Show or hide the checklist'], ['↑ / ↓', 'Move between messages when one is focused'], ['R', 'Reply to the focused message; Esc in the composer cancels the quote'], ['B', 'Ask a side question (or start a message with /btw)'],
  ['1–9, Enter', 'Pick an option on the latest open question, then answer'], ['← / →', 'Flip images in the viewer'], ['?', 'This cheat sheet'], ['Esc', 'Close the viewer or a dialog']];

// ---- Profile and avatars
// ---- Offline: messages written with no signal wait in an outbox and go out in order, each once (the server dedupes by client id).
async function postQueued(e) {
  try {
    const r = await fetch(`${API}threads/${e.thread}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: e.text, images: e.images, ...(e.aside ? { aside: true } : e.reply_to ? { reply_to: e.reply_to } : {}), client_id: e.cid, written_at: e.written_at }) });
    if (r.ok || r.status < 500) setOffline(false);
    let reason; if (!r.ok) { try { reason = (await r.json()).detail; } catch { /* no detail */ } }
    return { status: r.status, reason };
  } catch { setOffline(true); return { network: true }; }
}
const outbox = createOutbox({ post: postQueued, canSend: () => !isOffline(),
  onChange: () => { drawOffline(); if (state.detail) drawMessages(state.detail); },
  onSent: e => { state.echo.set(e.cid, e); const id = e.thread; Promise.all([id === state.openId ? loadThread(id, { quiet: true }) : null, refreshList()]).finally(() => { state.echo.delete(e.cid); if (state.detail) drawMessages(state.detail); }); } });
function drawOffline() {
  const banner = $('offline-banner'), n = outbox.pending(), off = isOffline();
  const waiting = n ? ` · ${n} waiting to send` : '';
  const warn = !outbox.persistent() && n ? ' · Closing this tab would lose them' : '';
  banner.hidden = !off && !n;
  banner.replaceChildren(...(off ? [el('span', { text: `Offline · showing what you last saw${waiting}` }), ...(warn ? [el('small', { text: warn })] : [])]
    : [el('span', { text: `Reconnecting · ${n} waiting to send` })]));
}
// ---- Small popup menus (the header's ⋯, the composer's ＋, a message's ⋯). One at a time; Escape or a click elsewhere closes it.
let menuAnchor = null;
function closeMenu(restore = true) {
  const menu = $('popmenu'); if (menu.hidden) return;
  menu.hidden = true; menu.replaceChildren();
  if (menuAnchor) { menuAnchor.setAttribute('aria-expanded', 'false'); if (restore) menuAnchor.focus?.(); }
  menuAnchor = null;
}
let menuUp = false;
function placeMenu() {
  const menu = $('popmenu'); if (menu.hidden || !menuAnchor) return;
  const r = menuAnchor.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, menuUp ? r.left : r.right - w))}px`;
  menu.style.top = `${menuUp ? Math.max(8, r.top - h - 6) : Math.max(8, Math.min(innerHeight - h - 8, r.bottom + 6))}px`;
}
function openMenu(anchor, items, { up = false } = {}) {
  closeMenu(false);
  const menu = $('popmenu');
  menu.replaceChildren(...items.map(it => (it.note ? el('p', { class: 'note', text: it.note }) : el('button', { type: 'button', role: 'menuitem', ...(it.disabled ? { disabled: '' } : {}), onclick: () => { closeMenu(false); it.onclick(); } }, it.label))));
  menu.hidden = false; menuAnchor = anchor; menuUp = up; anchor.setAttribute('aria-expanded', 'true');
  placeMenu();
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
// An agent with its own name (an MCP client) gets a colour made from the name, so two agents are never mistaken for each other.
const hueOf = name => { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
function avatar(who, big = false, name = '') {
  if (who === 'agent' && name) {
    const node = el('span', { class: 'avatar agent named', 'aria-hidden': 'true', text: ([...name][0] || '?').toUpperCase() });
    node.style.background = `hsl(${hueOf(name)} 52% 36%)`;
    if (big) node.style.cssText += ';width:100%;height:100%';
    return node;
  }
  const p = state.profile[who];
  const initial = ([...(p.name || '?')][0] || '?').toUpperCase();
  const node = p.avatar ? el('img', { class: `avatar ${who}`, src: p.avatar, alt: '' }) : el('span', { class: `avatar ${who}`, 'aria-hidden': 'true', text: initial });
  if (big) node.style.cssText = 'width:100%;height:100%';
  return node;
}
function drawMe() {
  $('me').replaceChildren(avatar('user'), el('span', { class: 'me-text' }, el('strong', { text: state.profile.user.name }), el('small', { text: 'Edit profile' })));
  $('me').setAttribute('aria-label', `${state.profile.user.name}: edit your profile`);
}
async function refreshProfile() {
  try {
    const p = await api('profile');
    if (JSON.stringify(p) !== JSON.stringify(state.profile)) { state.profile = p; drawMe(); state.shown = ''; if (state.detail) drawThread(); }
  } catch { /* keep the last profile */ }
}
const profile = { pending: undefined };
function paintAvatarPreview() {
  const c = $('avatar-preview'), g = c.getContext('2d');
  g.clearRect(0, 0, 96, 96);
  const show = profile.pending === undefined ? state.profile.user.avatar : profile.pending;
  if (!show) {
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--teal') || '#00796f'; g.fillRect(0, 0, 96, 96);
    g.fillStyle = '#fff'; g.font = '800 44px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(([...($('profile-name').value || state.profile.user.name)][0] || '?').toUpperCase(), 48, 50); return;
  }
  const img = new Image(); img.onload = () => { g.clearRect(0, 0, 96, 96); g.drawImage(img, 0, 0, 96, 96); }; img.src = show;
}
function cropSquare(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight), out = Math.min(256, side);
      const c = document.createElement('canvas'); c.width = c.height = out;
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}
function openProfile() {
  profile.pending = undefined; showError($('profile-error'), '');
  $('profile-name').value = state.profile.user.name; paintAvatarPreview(); $('profile-dialog').showModal(); $('profile-name').select();
}
async function saveProfile(event) {
  event.preventDefault(); showError($('profile-error'), '');
  try {
    const body = { name: $('profile-name').value };
    if (profile.pending !== undefined) body.avatar = profile.pending;
    state.profile = await post('profile', body); drawMe(); state.shown = ''; if (state.detail) drawThread();
    $('profile-dialog').close();
  } catch (error) { showError($('profile-error'), error.message); }
}

// ---- Images
const readDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read the image.'));
  reader.readAsDataURL(file);
});
async function addImages(list, files, errorEl, redraw) {
  errorEl.hidden = true;
  for (const file of files) {
    if (!TYPES.includes(file.type)) { showError(errorEl, 'Only PNG, JPEG or WebP images can be attached.'); continue; }
    if (file.size > MAX_BYTES) { showError(errorEl, 'Each image must be 10 MB or smaller.'); continue; }
    if (list.length >= MAX_IMAGES) { showError(errorEl, `At most ${MAX_IMAGES} images per message.`); break; }
    list.push(await readDataUrl(file));
  }
  redraw();
}
function showError(node, message) { node.textContent = message; node.hidden = !message; }
function drawPreviews(host, list, redraw) {
  host.replaceChildren(...list.map((url, i) => el('div', { class: 'preview' }, el('img', { src: url, alt: `Attached image ${i + 1}` }),
    el('button', { type: 'button', 'aria-label': `Remove image ${i + 1}`, text: '×', onclick: () => { list.splice(i, 1); redraw(); } }))));
}
function pastedImages(event) {
  return [...(event.clipboardData?.items ?? [])].filter(i => i.kind === 'file' && TYPES.includes(i.type)).map(i => i.getAsFile()).filter(Boolean);
}

// ---- Lightbox: every image of the open thread, in order.
function buildGallery(d) {
  const g = [];
  const cap = (label, extra) => `${label}${extra ? ` · ${extra}` : ''}`;
  if (d.files.image) g.push({ key: 'image.png', src: fileUrl(d.id, 'image.png'), caption: cap('Capture', d.mode) });
  if (d.files.annotated) g.push({ key: 'annotated.png', src: fileUrl(d.id, 'annotated.png'), caption: 'Capture · annotated' });
  if (d.files.context) g.push({ key: 'context.png', src: fileUrl(d.id, 'context.png'), caption: 'Capture · context' });
  d.messages.forEach((m, mi) => m.images.forEach((f, i) => g.push({ key: f, src: fileUrl(d.id, f),
    caption: `Message ${mi + 1} from ${m.author === 'user' ? state.profile.user.name : state.profile.agent.name}${m.images.length > 1 ? ` · image ${i + 1} of ${m.images.length}` : ''}` })));
  return g;
}
const lightOpen = () => $('lightbox').open;
function showGallery(i) {
  const n = state.gallery.length;
  if (!n) return;
  state.galleryAt = (i + n) % n;
  const g = state.gallery[state.galleryAt];
  const box = $('lightbox');
  box.querySelector('img').src = g.src; box.querySelector('img').alt = g.caption;
  $('light-cap').textContent = g.caption;
  $('light-count').textContent = `${state.galleryAt + 1} of ${n}`;
  for (const id of ['light-prev', 'light-next']) $(id).hidden = n < 2;
  $('light-count').hidden = n < 2;
}
function openGallery(key) {
  const i = state.gallery.findIndex(g => g.key === key);
  showGallery(i < 0 ? 0 : i);
  if (!lightOpen()) $('lightbox').showModal();
}
const flip = by => { if (state.gallery.length > 1) showGallery(state.galleryAt + by); };
function imageButton(key, label, src) {
  return el('button', { type: 'button', 'aria-label': `${label} (open full size)`, onclick: () => openGallery(key) }, el('img', { src, alt: label, loading: 'lazy' }));
}

// ---- List: organised by area
const PILL = { agent: 'Waiting for agent', you: 'Waiting on you', idle: 'Nothing needed', done: 'Done' };
const FLAG = { needs_you: ['Needs you', 'needs'], done: ['✓ Done', 'okay'], fyi: ['FYI', 'fyi'] };
const flagBadge = flag => (FLAG[flag] ? el('span', { class: `flag ${FLAG[flag][1]}`, text: FLAG[flag][0] }) : null);
const waitingAgent = t => t.waiting === 'agent';
const waitingYou = t => t.waiting === 'you';
function passes(t) {
  if (state.view === 'agent') return waitingAgent(t);
  if (state.view === 'you') return waitingYou(t);
  if (state.q) return true; // a search looks through everything
  return state.filter === 'all' || (state.filter === 'done') === (t.status === 'done');
}
const rank = (a, b) => (b.unread_for_user - a.unread_for_user) || b.last_message_at.localeCompare(a.last_message_at);
// Folds are saved as true/false; a group with nothing saved uses its default (Done groups start folded).
const foldOf = (key, dflt = false) => (key in state.folds ? !!state.folds[key] : dflt);
function setFold(key, folded) { state.folds[key] = folded; saveFolds(); drawList(); }
const isPinned = (kind, id) => (kind === 'thread' ? state.pins.threads : state.pins.areas).includes(id);
async function togglePin(kind, id) {
  try { state.pins = await post('pins', { kind, id }); } catch { /* keep the old pins */ }
  drawList(); drawPinThread();
}
function pinButton(kind, id, label) {
  const on = isPinned(kind, id);
  return el('button', { type: 'button', class: 'pin', 'aria-pressed': String(on), 'aria-label': `${on ? 'Unpin' : 'Pin'} ${label}`, title: on ? 'Unpin' : 'Pin to the top',
    onclick: e => { e.preventDefault(); e.stopPropagation(); togglePin(kind, id); } }, on ? '★' : '☆');
}
function checklistSummary(c) { return c.total ? `${c.done} of ${c.total} done${c.claimed ? ` · ${c.claimed} claimed` : ''}` : ''; }
function threadRow(t) {
  const badge = t.last_flag ? flagBadge(t.last_flag) : null;
  state.order.push(t.id);
  const link = el('a', { href: `#/${t.id}`, ...(t.id === state.openId ? { 'aria-current': 'true' } : {}) },
    el('div', { class: 'row-title' }, ...(t.unread_for_user ? [el('span', { class: 'dot', role: 'img', 'aria-label': t.read_only ? 'Unread update' : 'Unread: needs you' })] : []), el('span', { class: 't', text: t.title })),
    el('div', { class: 'meta' }, t.read_only && t.status !== 'done' ? el('span', { class: 'pill upd', text: 'Updates' }) : el('span', { class: `pill ${t.waiting}`, text: PILL[t.waiting] }), ...(badge ? [badge] : []), ...(t.open_question ? [el('span', { class: 'pill q', text: 'Question' })] : []),
      ...((t.checklist?.total) ? [el('span', { class: 'tally', title: checklistSummary(t.checklist) }, donutNode(t.checklist), `${t.checklist.done}/${t.checklist.total}`)] : []),
      el('time', { datetime: t.last_message_at, text: when(t.last_message_at) })));
  return el('li', { class: 'row' }, link, pinButton('thread', t.id, t.title));
}
// Rows of one group, split under headings when the group's rule has a subHeading and several values share it.
function rowItems(key, rows) {
  const subs = [...new Set(rows.map(t => areaOf(t, state.areaConfig).sub).filter(s => s !== undefined))].sort();
  if (subs.length < 2) return rows.map(threadRow);
  const plain = rows.filter(r => areaOf(r, state.areaConfig).sub === undefined).map(threadRow); // threads of the rule with no such path segment come first, without a heading
  return [...plain, ...subs.flatMap(sub => [el('li', { class: 'sub', text: subHeading(key, sub, state.areaConfig) ?? sub }), ...rows.filter(r => areaOf(r, state.areaConfig).sub === sub).map(threadRow)])];
}
function foldButton(key, label, count, folded, extra = []) {
  const btn = el('button', { type: 'button', 'aria-expanded': String(!folded), 'aria-controls': `g-${key}`, onclick: () => setFold(key, !folded) },
    el('span', { class: 'chev', 'aria-hidden': 'true', text: '▾' }), el('span', { class: 'name', text: label }), ...extra, el('span', { class: 'count', text: String(count) }));
  return btn;
}
// Open threads first; done ones fold into "Done (n)" at the bottom of the group (only on the All view, so Open and Done stay plain).
function groupNode(key, label, rows, foldDone) {
  const folded = foldOf(key);
  const unread = rows.filter(t => t.unread_for_user).length;
  const head = el('h3', {}, foldButton(key, label, rows.length, folded, unread ? [el('span', { class: 'unreadc', text: `${unread} unread` })] : []), pinButton('area', key, label));
  const section = el('section', { class: 'group', 'data-group': key }, head);
  if (folded) return section;
  const open = foldDone ? rows.filter(t => t.status !== 'done') : rows;
  const done = foldDone ? rows.filter(t => t.status === 'done') : [];
  const list = el('ul', { id: `g-${key}` }, ...rowItems(key, open));
  if (done.length) {
    const dkey = `done:${key}`, dfolded = foldOf(dkey, true);
    list.append(el('li', { class: 'donehead' }, el('h4', {}, foldButton(dkey, 'Done', done.length, dfolded))));
    if (!dfolded) list.append(...rowItems(key, done));
  }
  section.append(list);
  return section;
}
function drawList() {
  const rows = state.threads.filter(passes).sort(rank);
  const foldDone = state.filter === 'all' && !state.q && !state.view;
  const pinnedAreas = new Set(state.pins.areas);
  const pinnedOnly = t => isPinned('thread', t.id) && !pinnedAreas.has(areaOf(t, state.areaConfig).area);
  const by = new Map();
  for (const t of rows) if (!pinnedOnly(t)) { const a = areaOf(t, state.areaConfig).area; (by.get(a) ?? by.set(a, []).get(a)).push(t); }
  state.order = [];
  const nodes = [];
  const pinThreads = rows.filter(pinnedOnly), pinAreas = sortAreas([...by.keys()], state.areaConfig).filter(k => pinnedAreas.has(k)).map(k => [k, areaLabel(k, state.areaConfig)]);
  if (pinThreads.length || pinAreas.length) {
    const box = el('section', { class: 'group pinned', 'data-group': 'pinned' }, el('h3', {}, el('span', { class: 'pinned-h', text: '★ Pinned' })));
    for (const [k, label] of pinAreas) box.append(groupNode(k, label, by.get(k), foldDone));
    if (pinThreads.length) box.append(el('ul', {}, ...pinThreads.map(threadRow)));
    nodes.push(box);
  }
  for (const k of sortAreas([...by.keys()], state.areaConfig)) if (!pinnedAreas.has(k)) nodes.push(groupNode(k, areaLabel(k, state.areaConfig), by.get(k), foldDone));
  $('groups').replaceChildren(...nodes);
  $('list-empty').hidden = rows.length > 0;
  $('list-empty').textContent = state.q ? 'No thread matches that search.' : state.view === 'agent' ? 'Nothing is waiting for the agent.' : state.view === 'you' ? 'Nothing is waiting on you.' : 'No threads here.';
  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(!state.view && !state.q && b.dataset.filter === state.filter));
  $('view-agent').setAttribute('aria-pressed', String(state.view === 'agent'));
  $('view-you').setAttribute('aria-pressed', String(state.view === 'you'));
  $('count-agent').textContent = String(state.threads.filter(waitingAgent).length);
  $('count-you').textContent = String(state.threads.filter(waitingYou).length);
}
async function refreshPins() {
  try { const p = await api('pins'); if (JSON.stringify(p) !== JSON.stringify(state.pins)) { state.pins = p; drawList(); drawPinThread(); } } catch { /* keep the last pins */ }
}
// The area rules come from the server, so the inbox groups threads the way the metrics do.
async function refreshAreas() {
  try { state.areaConfig = await api('areas'); } catch { /* keep the default grouping */ }
}
async function refreshList() {
  try { state.threads = await api(state.q ? `threads?q=${encodeURIComponent(state.q)}` : 'threads'); drawList(); } catch { /* keep the last list; the next poll retries */ }
}
// Counts for the pinned views come from the unfiltered list, so a search must not hide them.
function step(by) {
  const i = state.order.indexOf(state.openId);
  const next = state.order[i < 0 ? (by > 0 ? 0 : state.order.length - 1) : Math.min(state.order.length - 1, Math.max(0, i + by))];
  if (next && next !== state.openId) { location.hash = `#/${next}`; requestAnimationFrame(() => document.querySelector('#groups a[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })); }
}

// ---- Thread
function describeTarget(d) {
  const parts = [];
  if (d.url) parts.push(`Page: ${d.url}`);
  const t = d.target;
  if (t && typeof t === 'object') {
    if (t.selector) parts.push(`Target: ${t.selector}`);
    if (t.name || t.text) parts.push(`Text: ${String(t.name || t.text).slice(0, 120)}`);
  }
  if (d.viewport) parts.push(`Viewport: ${d.viewport.width}×${d.viewport.height}`);
  return parts.join(' · ');
}
function drawCapture(d) {
  const box = $('capture');
  if (!d.files.image) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const extras = el('div', { class: 'extra', id: 'extras', hidden: '' });
  if (d.files.annotated) extras.append(el('figure', {}, imageFig('annotated.png', fileUrl(d.id, 'annotated.png'), 'Annotated capture'), el('figcaption', { text: 'Annotated' })));
  if (d.files.context) extras.append(el('figure', {}, imageFig('context.png', fileUrl(d.id, 'context.png'), 'Context: the viewport with the target outlined'), el('figcaption', { text: 'Context' })));
  const kids = [imageButtonBlock('image.png', fileUrl(d.id, 'image.png'), `Captured ${d.mode}`), el('p', { class: 'info', text: describeTarget(d) })];
  if (extras.children.length) {
    const toggle = el('button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'extras', text: 'Show context' });
    toggle.addEventListener('click', () => { const open = extras.hidden; extras.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); toggle.textContent = open ? 'Hide context' : 'Show context'; });
    kids.push(el('p', { class: 'info' }, toggle), extras);
  }
  box.replaceChildren(...kids);
}
const imageFig = (key, src, alt) => el('button', { type: 'button', style: 'padding:0;border-width:1px;display:block;max-width:100%;line-height:0;overflow:hidden', 'aria-label': `${alt} (open full size)`, onclick: () => openGallery(key) }, el('img', { src, alt }));
const imageButtonBlock = imageFig;

// Structured questions: the agent asks, the user answers with a normal message carrying `answer`.
function answerFor(d, q) { return d.messages.find(m => m.answer && m.answer.question_id === q.id) || null; }
function activeQuestion() {
  const d = state.detail; if (!d) return null;
  const open = d.messages.filter(m => m.question && !answerFor(d, m.question)).map(m => m.question);
  return open[open.length - 1] || null;
}
const selFor = q => (state.qsel[q.id] ??= { ids: [], other: '' });
function toggleOption(q, optId) {
  const s = selFor(q);
  if (q.multi) s.ids = s.ids.includes(optId) ? s.ids.filter(i => i !== optId) : [...s.ids, optId]; else s.ids = [optId];
  paintCard(q);
}
function paintCard(q) {
  const card = document.querySelector(`[data-question="${q.id}"]`); if (!card) return;
  const s = selFor(q);
  for (const b of card.querySelectorAll('.qopt')) b.setAttribute('aria-pressed', String(s.ids.includes(b.dataset.opt)));
  const submit = card.querySelector('.qsubmit'); if (submit) submit.disabled = !s.ids.length && !s.other.trim();
}
async function submitAnswer(q) {
  const d = state.detail, s = selFor(q);
  if (!d || state.busy || (!s.ids.length && !s.other.trim())) return;
  state.busy = true;
  try {
    await post(`threads/${d.id}/answer`, { question_id: q.id, option_ids: s.ids, ...(s.other.trim() ? { other_text: s.other.trim() } : {}) });
    delete state.qsel[q.id];
    await Promise.all([loadThread(d.id), refreshList()]);
  } catch (error) { showError($('error'), error.message); await loadThread(d.id, { quiet: true }); }
  finally { state.busy = false; }
}
function questionCard(d, m) {
  const q = m.question, ans = answerFor(d, q), s = selFor(q);
  const card = el('div', { class: 'qcard', 'data-question': q.id, role: 'group', 'aria-label': 'Question' }, el('p', { class: 'prompt', text: q.prompt }));
  const chosen = ans ? ans.answer.option_ids : [];
  const opts = el('div', { class: 'qopts' }, ...q.options.map((o, i) => {
    const b = el('button', { type: 'button', class: `qopt${chosen.includes(o.id) ? ' chosen' : ''}`, 'data-opt': o.id, 'aria-pressed': String(ans ? chosen.includes(o.id) : s.ids.includes(o.id)),
      onclick: () => { toggleOption(q, o.id); if (!q.multi && !s.other.trim()) submitAnswer(q); } },
      el('span', { class: 'n', 'aria-hidden': 'true', text: String(i + 1) }), el('span', {}, o.label, ...(o.description ? [el('span', { class: 'd', text: o.description })] : [])));
    if (ans) b.disabled = true;
    return b;
  }));
  card.append(opts);
  if (ans) {
    if (ans.answer.other_text) card.append(el('p', { class: 'info', text: `Other: ${ans.answer.other_text}` }));
    card.append(el('p', { class: 'locked', text: `Answered: ${ans.text.replace(/^Chose: /, '')}` }));
    return card;
  }
  if (q.allow_other) {
    const other = el('input', { type: 'text', class: 'qother', placeholder: 'Other (write your own answer)', maxlength: '1000', 'aria-label': 'Other answer' });
    other.value = s.other;
    other.addEventListener('input', () => { s.other = other.value; paintCard(q); });
    other.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAnswer(q); } });
    card.append(other);
  }
  const submit = el('button', { type: 'button', class: 'primary qsubmit', onclick: () => submitAnswer(q) }, 'Submit', kbd('Enter'));
  card.append(el('div', { class: 'qbar' }, submit, el('span', { class: 'hint', text: q.multi ? 'Choose any number. Keys 1–9 toggle, Enter submits.' : 'Click an option, or press its number then Enter.' })));
  queueMicrotask(() => paintCard(q));
  return card;
}

function ticksFor(d, m) {
  if (m.author === 'user') {
    const acked = !!d.acked_through && d.acked_through >= m.created_at; // the agent handled it without replying
    const read = acked || (d.agent_read_at && d.agent_read_at >= m.created_at);
    const name = state.profile.agent.name;
    return el('span', { class: `ticks${read ? ' read' : ''}`, role: 'img', 'aria-label': acked ? `Acknowledged by ${name}, no reply needed` : read ? `Read by ${name}` : 'Sent', text: read ? '✓✓' : '✓' });
  }
  if (d.user_read_at && d.user_read_at >= m.created_at) return el('span', { class: 'ticks read', role: 'img', 'aria-label': 'Seen by you', text: '✓✓' });
  return null;
}
// FYI and Done messages from the agent fold to one line; Needs you messages and questions stay open. A read-only (updates) thread never folds.
// Off by default: every message shows in full. FEEDBACK_FOLD_FYI=1 on the server sets data-fold-fyi on <body> to fold agent FYI and Done messages to one line.
const FOLD_FYI = document.body.hasAttribute('data-fold-fyi');
const quiet = (d, m) => FOLD_FYI && !d.read_only && m.author === 'agent' && (m.flag === 'fyi' || m.flag === 'done') && !m.question && !m.divider;
const expandKey = (d, m) => `${d.id}:${m.id}`;
function toggleExpanded(d, m) { const k = expandKey(d, m); if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k); state.shown = ''; drawMessages(d); }
function messageNode(d, m) {
  if (m.divider && m.moved_to) return el('div', { class: 'divider', role: 'separator', 'data-mid': m.id }, el('span', {}, 'Moved to ', el('a', { href: `#/${m.moved_to}`, text: (/^Moved to \[(.*)\]\(#\//.exec(m.text) || [])[1] || 'another thread' })));
  if (m.divider) return el('div', { class: 'divider', role: 'separator' }, el('span', { text: m.text }));
  const who = m.agent_name ? { ...state.profile.agent, name: m.agent_name } : state.profile[m.author];
  const farewell = d.merged_into && m === d.messages[d.messages.length - 1]; // the link to the merged thread stays visible
  const folded = quiet(d, m) && !farewell && !state.expanded.has(expandKey(d, m));
  const badge = m.author === 'agent' ? flagBadge(m.flag) : null;
  if (folded) {
    const first = (m.redacted ? '🔒 Redacted' : firstPlainLine(m.text) || (m.images.length ? '[image]' : '')).slice(0, 160);
    return el('article', { class: 'msg agent collapsed', 'data-mid': m.id, 'aria-label': `${who.name}, ${when(m.created_at)}, ${FLAG[m.flag][0]}` },
      avatar(m.author, false, m.agent_name), ...(badge ? [badge] : []), el('span', { class: 'peek', text: first }), el('time', { datetime: m.created_at, text: when(m.created_at) }),
      el('button', { type: 'button', class: 'show', onclick: () => toggleExpanded(d, m) }, 'Show'));
  }
  const head = el('div', { class: 'who' }, avatar(m.author, false, m.agent_name), el('strong', { text: who.name }), ' · ', el('time', { datetime: m.written_at || m.created_at, text: when(m.written_at || m.created_at), ...sentTitle(m) }), ...(badge ? [badge] : []));
  if (quiet(d, m) && !farewell) head.append(el('button', { type: 'button', class: 'show', onclick: () => toggleExpanded(d, m) }, 'Hide'));
  if (m.author === 'user' && d.acked_through === m.created_at) head.append(el('span', { class: 'acked-note', text: `· ${state.profile.agent.name} acknowledged` }));
  const ticks = ticksFor(d, m); if (ticks) head.append(ticks);
  if (!d.read_only) head.append(el('button', { type: 'button', class: 'reply-btn', 'aria-label': `Reply to ${who.name}, ${when(m.created_at)}`, onclick: () => startReply(m.id) }, 'Reply'));
  if (m.author === 'user' && !m.redacted && state.config?.redact) head.append(el('button', { type: 'button', class: 'msg-more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `More actions for your message of ${when(m.created_at)}`, onclick: e => openMenu(e.currentTarget, [{ label: 'Redact…', onclick: () => askRedact(d, m) }]) }, '⋯'));
  const node = el('article', { class: `msg ${m.author}${m.flag === 'needs_you' ? ' needs' : ''}`, 'data-mid': m.id, tabindex: '-1', 'aria-label': `${who.name}, ${when(m.created_at)}` }, head);
  const quoted = quoteNode(d, m); if (quoted) node.append(quoted);
  if (m.redacted) { node.classList.add('redacted'); node.append(el('p', { class: 'locked', ...(m.redacted.reason ? { title: m.redacted.reason } : {}), text: lockedText(m) })); return node; }
  if (m.question) node.append(questionCard(d, m)); else if (m.text) node.append(markdown(m.text));
  if (m.kind === 'secret_request' && m.secret) node.append(secretNode(d, m));
  if (m.images.length) node.append(el('div', { class: 'imgs' }, ...m.images.map((f, i) => imageButton(f, `Image ${i + 1} from ${who.name}`, fileUrl(d.id, f)))));
  const attached = attachedNode(d, m); if (attached) node.append(attached);
  return node;
}
// ---- The key box. The value goes from this page straight to the app's own key store (FEEDBACK_SECRET_TARGET, a path on this same site).
// It never goes to the feedback server, a thread, the events log, localStorage or the offline outbox: it lives only in this input until the app has it, and is cleared on success.
// All the feedback server hears is "saved" and the app's short hint ("…abcd").
function secretNode(d, m) {
  const key = `${d.id}:${m.id}`;
  let s = state.secrets.get(key);
  if (!s) {
    const input = el('input', { type: 'password', id: `secret-${d.id}-${m.id}`, autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': m.secret.label, placeholder: 'Paste it here', 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-bwignore': 'true' });
    s = { box: el('div', { class: 'secret', 'data-secret': m.secret.name }), input, error: '', busy: false };
    state.secrets.set(key, s);
  }
  paintSecret(s, d, m, key);
  return s.box;
}
function paintSecret(s, d, m, key) {
  const sec = m.secret, target = state.config?.secret_target;
  const help = sec.help_url && /^https:\/\//.test(sec.help_url) ? [el('a', { href: sec.help_url, target: '_blank', rel: 'noopener noreferrer', text: 'Where to get this' })] : [];
  const saved = sec.status === 'saved' && !state.replacing.has(key);
  if (saved) {
    s.box.replaceChildren(el('div', { class: 'secret-meta' }, el('span', { class: `secret-ok${sec.check === 'rejected' ? ' rejected' : ''}`, role: 'status', text: secretStatusLine(sec) }),
      el('button', { type: 'button', class: 'show', onclick: () => { state.replacing.add(key); state.shown = ''; drawMessages(state.detail); s.input.focus(); } }, 'Replace')));
    return;
  }
  if (state.config && !target) { s.box.replaceChildren(el('p', { class: 'secret-note', text: "Secure entry isn't set up on this server" })); return; }
  const off = isOffline();
  s.input.disabled = off || s.busy;
  // No <form>: a browser offers to save a password only for a form, so there is nothing to offer here. Enter in the box saves.
  s.input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); void saveSecret(s, d, m, key); } };
  const save = el('button', { type: 'button', class: 'primary', onclick: () => { void saveSecret(s, d, m, key); }, ...(off || s.busy ? { disabled: '' } : {}), text: s.busy ? 'Saving…' : 'Save' });
  const form = el('div', { class: 'secret-form' },
    el('label', { for: s.input.id, class: 'secret-label' }, sec.label, el('code', { class: 'secret-slot', text: ` → ${sec.name}` })),
    el('div', { class: 'secret-row' }, s.input, save),
    el('div', { class: 'secret-meta' }, ...help, el('span', { class: 'secret-note', style: 'margin:0', text: 'Goes straight to the app. Never saved in this thread.' })));
  const err = el('p', { class: 'error', role: 'alert', text: s.error }); err.hidden = !s.error;
  s.box.replaceChildren(form, ...(off ? [el('p', { class: 'secret-note', role: 'status', text: 'Connect to save this key' })] : []), err);
}
async function saveSecret(s, d, m, key) {
  const value = s.input.value;
  if (!value.trim() || s.busy) return;
  const url = secretUrl(state.config?.secret_target, m.secret.name, location.origin);
  const fail = message => { s.error = message; s.busy = false; paintSecret(s, d, m, key); };
  if (!url) return fail("Secure entry isn't set up correctly on this server.");
  if (isOffline()) return fail('Connect to save this key.');
  s.busy = true; s.error = ''; paintSecret(s, d, m, key);
  let response;
  try { response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }), credentials: 'same-origin', redirect: 'error', cache: 'no-store' }); }
  catch { setOffline(true); return fail("Couldn't reach the app, so the key was not saved. Try again when you're connected."); }
  let data = {};
  try { data = await response.json(); } catch { /* no body */ }
  if (!response.ok) { const why = [data.detail, data.error, data.message].find(x => typeof x === 'string' && x); return fail(why ? String(why).slice(0, 200) : `The app refused it (${response.status}).`); }
  s.input.value = ''; // the app has it: nothing keeps it here
  const hint = typeof data.hint === 'string' ? data.hint.slice(0, 8) : '', check = data.check === 'rejected' || data.check === 'works' ? data.check : '';
  s.busy = false; state.replacing.delete(key);
  try { await post(`threads/${d.id}/messages/${m.id}/secret`, { status: 'saved', ...(hint ? { hint } : {}), ...(check ? { check } : {}) }); }
  catch { s.error = 'Saved in the app, but the thread could not be told. It will show as saved once you reload.'; }
  state.shown = ''; if (state.detail) await loadThread(d.id, { quiet: true }); else paintSecret(s, d, m, key);
}
// ---- Redact one of your own messages: its text and pictures move to the server's private vault. There is no restore here.
function askRedact(d, m) { state.redactFor = { thread: d.id, mid: m.id }; showError($('redact-error'), ''); $('redact-dialog').showModal(); $('redact-go').focus(); }
async function doRedact() {
  const r = state.redactFor; if (!r) return;
  try { await post(`threads/${r.thread}/messages/${r.mid}/redact`, {}); $('redact-dialog').close(); state.redactFor = null; state.shown = ''; await Promise.all([loadThread(r.thread, { quiet: true }), refreshList()]); }
  catch (error) { showError($('redact-error'), error.message); }
}
// Checklist items a message added or ticked: a small list inside the bubble; each item jumps to its row in the checklist panel.
function attachedNode(d, m) {
  const lines = [['Added to checklist', m.added_items], ['Ticked', m.ticked_items]].filter(([, ids]) => ids && ids.length);
  if (!lines.length) return null;
  const items = d.checklist_items || [];
  return el('div', { class: 'attached' }, ...lines.map(([label, ids]) => el('p', { 'data-attached': label === 'Ticked' ? 'ticked' : 'added' }, el('strong', { text: `${label}:` }),
    ...ids.map(id => {
      const it = items.find(i => i.id === id);
      return it ? el('button', { type: 'button', class: 'att-item', 'data-item': id, 'aria-label': `${label}: ${it.text}. Show it in the checklist.`, onclick: () => jumpToItem(id) }, inline(it.text))
        : el('span', { class: 'att-item gone', title: 'This item was removed from the checklist', text: id });
    }))));
}
function jumpToItem(id) {
  const d = state.detail; if (!d) return;
  if (isNarrow()) openSheet(); else if (!panelOpen(d)) setPanel(d, true);
  const row = $('cl-body').querySelector(`[data-item="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1700);
}
// ---- Side questions (/btw): a compact, collapsible bubble set apart from the main flow. Collapsed once answered; open (with a pill) while waiting.
const asideKey = (d, root) => `${d.id}:${root.id}`;
const asideIsOpen = (d, g) => (state.asideOpen.has(asideKey(d, g.root)) ? state.asideOpen.get(asideKey(d, g.root)) : !g.answered);
function toggleAside(d, g) { state.asideOpen.set(asideKey(d, g.root), !asideIsOpen(d, g)); state.shown = ''; drawMessages(d); }
function asideMsgNode(d, m) {
  const who = m.agent_name ? { ...state.profile.agent, name: m.agent_name } : state.profile[m.author];
  const node = el('div', { class: `aside-msg ${m.author}`, 'data-aside-mid': m.id }, el('div', { class: 'who' }, avatar(m.author, false, m.agent_name), el('strong', { text: who.name }), ' · ', el('time', { datetime: m.created_at, text: when(m.created_at) })));
  if (m.redacted) { node.append(el('p', { class: 'locked', text: lockedText(m) })); return node; }
  if (m.text) node.append(markdown(m.text));
  if (m.images.length) node.append(el('div', { class: 'imgs' }, ...m.images.map((f, i) => imageButton(f, `Image ${i + 1} from ${who.name}`, fileUrl(d.id, f)))));
  const attached = attachedNode(d, m); if (attached) node.append(attached);
  return node;
}
function asideNode(d, g) {
  const open = asideIsOpen(d, g), agent = state.profile.agent.name;
  const first = (g.root.redacted ? '🔒 Redacted' : firstPlainLine(g.root.text) || (g.root.images.length ? '[image]' : '')).slice(0, 120);
  const id = `aside-${g.root.id}`;
  const head = el('button', { type: 'button', class: 'aside-head', 'aria-expanded': String(open), 'aria-controls': id, onclick: () => toggleAside(d, g) },
    el('span', { class: 'chev', 'aria-hidden': 'true', text: '▾' }), el('strong', { text: 'Side question' }),
    ...(open ? [] : [el('span', { class: 'peek', text: first })]), ...(g.answered ? [] : [el('span', { class: 'pill agent', text: 'Waiting for agent', title: `Waiting for ${agent}` })]),
    ...(g.answered && !open ? [el('span', { class: 'hint', text: g.answers.length === 1 ? '1 answer' : g.answers.length ? `${g.answers.length} answers` : 'Acknowledged' })] : []));
  const node = el('section', { class: `aside-group${g.answered ? '' : ' waiting'}`, 'data-mid': g.root.id, 'data-aside': g.answered ? 'answered' : 'waiting', 'aria-label': 'Side question' }, head);
  if (open) node.append(el('div', { class: 'aside-body', id }, ...[g.root, ...g.answers].map(m => asideMsgNode(d, m))));
  return node;
}
// Main messages in thread order, with each side question (and its answers) at the place it was asked.
// A reminder that fired: a small muted line for the user to see; it was sent to the agent only (never a notification, never unread).
const reminderLine = f => el('div', { class: 'sysline', role: 'note', 'data-reminder': f.id }, el('span', { 'aria-hidden': 'true', text: '⏰ ' }), el('span', { text: 'Reminder to the agent: ' }), el('span', { class: 'say', text: f.text }), ' ', el('time', { datetime: f.at, text: when(f.at) }));
function threadNodes(d) {
  const groups = asideGroups(d.messages, d.acked_through || null);
  const grouped = new Set(groups.flatMap(g => [g.root.id, ...g.answers.map(a => a.id)]));
  const fired = [...(d.reminders_fired || [])].sort((a, b) => a.at.localeCompare(b.at));
  const lines = at => { const out = []; while (fired.length && (at === null || fired[0].at <= at)) out.push(reminderLine(fired.shift())); return out; };
  return d.messages.flatMap(m => {
    const before = lines(m.created_at);
    const g = groups.find(x => x.root.id === m.id);
    if (g) return [...before, asideNode(d, g)];
    if (isAside(m) && !grouped.has(m.id)) return before; // an answer whose question is gone
    return [...before, messageNode(d, m)];
  }).concat(lines(null), queuedNodes(d));
}
// Messages written offline (or still sending) show at the end of the thread, with a clock until the server has them.
const clockIcon = () => svg('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true', class: 'clock' }, svg('circle', { cx: 12, cy: 12, r: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }), svg('path', { d: 'M12 7v5l3 2', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
function queuedEntries(d) {
  const mine = outbox.forThread(d.id), have = new Set(d.messages.map(m => m.client_id).filter(Boolean));
  return [...mine, ...[...state.echo.values()].filter(e => e.thread === d.id && !have.has(e.cid))];
}
function queuedNodes(d) { return queuedEntries(d).filter(e => !((d.messages || []).some(m => m.client_id === e.cid))).map(e => queuedNode(d, e)); }
function queuedNode(d, e) {
  const failed = e.state === 'failed', sent = state.echo.has(e.cid);
  const head = el('div', { class: 'who' }, avatar('user'), el('strong', { text: state.profile.user.name }), ' · ', el('time', { datetime: e.written_at, text: when(e.written_at) }));
  const node = el('article', { class: `msg user queued${failed ? ' failed' : ''}`, 'data-queued': e.cid, 'aria-label': `${state.profile.user.name}, ${when(e.written_at)}, ${failed ? 'not sent' : 'waiting to send'}` }, head);
  if (e.aside) node.append(el('p', { class: 'hint', style: 'margin:0 0 2px', text: 'Side question' }));
  const quoted = e.reply_to ? quoteNode(d, { reply_to: e.reply_to }) : null; if (quoted) node.append(quoted);
  if (e.text) node.append(markdown(e.text));
  if (e.images.length) node.append(el('div', { class: 'imgs' }, ...e.images.map((src, i) => el('span', {}, el('img', { src, alt: `Picture ${i + 1}, waiting to send` })))));
  if (sent) { node.classList.remove('queued'); return node; }
  if (failed) node.append(el('div', { class: 'qstate bad', role: 'note' }, el('span', { text: `Couldn't send: ${e.reason}` }), el('button', { type: 'button', onclick: () => outbox.retry(e.cid) }, 'Try again'), el('button', { type: 'button', onclick: () => outbox.remove(e.cid) }, 'Delete')));
  else node.append(el('div', { class: 'qstate', 'data-state': e.sending ? 'sending' : 'waiting' }, clockIcon(), el('span', { text: e.sending ? 'Sending…' : e.attempts ? 'Waiting to send · will retry' : 'Waiting to send' }),
    ...(e.sending ? [] : [el('button', { type: 'button', 'aria-label': 'Delete this message before it sends', onclick: () => outbox.remove(e.cid) }, 'Delete')])));
  return node;
}
function drawMessages(d) {
  const open = [...state.expanded].filter(k => k.startsWith(`${d.id}:`)).sort();
  const asides = [...state.asideOpen].filter(([k]) => k.startsWith(`${d.id}:`));
  const key = JSON.stringify([d.id, d.status, d.user_read_at, (d.reminders_fired || []).map(f => f.at + f.id), d.agent_read_at, d.acked_through, state.profile, open, asides, d.messages.map(m => m.id + m.created_at + (m.answer ? 'a' : '') + (m.flag || '') + (m.aside ? 's' : '') + (m.added_items || []).join() + (m.ticked_items || []).join() + (m.redacted ? 'r' : '') + (m.secret?.status || '') + (m.secret?.hint || '')),
    queuedEntries(d).map(e => e.cid + e.state + e.attempts + e.sending), state.offline, state.config?.secret_target || '', state.config?.redact === true, [...state.replacing],
    (d.checklist_items || []).filter(i => d.messages.some(m => (m.added_items || []).includes(i.id) || (m.ticked_items || []).includes(i.id))).map(i => i.id + i.text)]);
  state.gallery = buildGallery(d);
  if (key === state.shown) return;
  const first = state.shown === '' || !state.shown.startsWith(`["${d.id}"`);
  const scroll = $('scroll');
  const stick = first || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  state.shown = key;
  const focused = document.activeElement?.matches?.('.secret input') ? document.activeElement : null; // a key being typed keeps its place
  $('msgs').replaceChildren(...threadNodes(d));
  if (focused?.isConnected) focused.focus();
  applyStop();
  if (stick) scroll.scrollTop = scroll.scrollHeight;
}

// ---- Quote replies: a Reply action on each message, a quote bar above the composer, and a quoted snippet on the reply.
function quoteNode(d, m) {
  const q = resolveQuote(d.messages, m);
  if (!q) return null;
  if (!q.found) return el('span', { class: 'quote missing', role: 'note', text: q.snippet });
  const name = state.profile[q.original.author].name;
  return el('button', { type: 'button', class: `quote ${q.original.author}`, 'aria-label': `In reply to ${name}: ${q.snippet || 'message'}. Go to the original.`, onclick: () => jumpTo(q.original.id) },
    el('strong', { text: name }), el('span', { class: 'snip', text: q.snippet }));
}
// Roving tabindex: one message is the tab stop (the last focused, else the newest); arrow keys move between them.
const msgNodes = () => [...$('msgs').querySelectorAll(':scope > .msg[data-mid]')];
function applyStop() {
  const nodes = msgNodes(); if (!nodes.length) return;
  const stop = nodes.find(n => n.dataset.mid === state.msgStop) || nodes[nodes.length - 1];
  for (const n of nodes) n.tabIndex = n === stop ? 0 : -1;
}
function moveMsg(from, by) {
  const nodes = msgNodes(), i = nodes.indexOf(from); if (i < 0) return;
  const to = nodes[by === 'start' ? 0 : by === 'end' ? nodes.length - 1 : Math.max(0, Math.min(nodes.length - 1, i + by))];
  to.focus();
}
function messageEl(id) { return [...$('msgs').children].find(n => n.dataset.mid === id) || null; }
function jumpTo(id) {
  const node = messageEl(id);
  if (!node) return;
  node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  node.focus({ preventScroll: true });
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1700);
}
function drawReplyBar() {
  const d = state.detail, m = state.replyTo && d ? d.messages.find(x => x.id === state.replyTo) : null;
  if (state.replyTo && !m && d) state.replyTo = null; // the original is gone
  $('replybar').hidden = !m;
  if (!m) return;
  $('replybar-text').replaceChildren(el('strong', { text: state.profile[m.author].name }), snippetOf(m));
}
function startReply(id) {
  const d = state.detail; if (!d || d.read_only || !d.messages.some(m => m.id === id && !m.divider)) return;
  state.replyTo = id; drawReplyBar(); $('text').focus();
}
// B (or the Side question button on an empty composer) starts a side question: the composer gets a `/btw ` prefix.
function startAside() {
  const d = state.detail; if (!d || d.read_only) return;
  const box = $('text'); if (!parseBtw(box.value).aside) box.value = `/btw ${box.value}`;
  box.focus(); box.setSelectionRange(box.value.length, box.value.length);
}
function cancelReply() { state.replyTo = null; drawReplyBar(); }
// Swipe a message to the right to reply (touch). The Reply button stays for anyone who cannot swipe.
const swipe = { node: null, x: 0, y: 0 };
// A touch that starts inside something that scrolls sideways (a table, a code block) is that thing's pan, never a swipe to reply.
function startsInScroller(target, within) {
  for (let n = target; n && n !== within; n = n.parentElement) {
    if (n.matches?.('.md-table, pre, table')) return true;
    if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
  }
  return false;
}
function swipeStart(e) {
  const node = e.target.closest && e.target.closest('.msg[data-mid]');
  if (!node || e.touches.length !== 1 || state.detail?.read_only || startsInScroller(e.target, node)) { swipe.node = null; return; }
  swipe.node = node; swipe.x = e.touches[0].clientX; swipe.y = e.touches[0].clientY;
}
function swipeMove(e) {
  if (!swipe.node) return;
  const dx = e.touches[0].clientX - swipe.x, dy = e.touches[0].clientY - swipe.y;
  if (dx > 8 && dx > Math.abs(dy)) { swipe.node.classList.add('swiping'); swipe.node.style.transform = `translateX(${Math.min(dx, 72)}px)`; }
}
function swipeEnd(e) {
  const node = swipe.node; swipe.node = null;
  if (!node) return;
  const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  node.classList.remove('swiping'); node.classList.add('swipe-back'); node.style.transform = '';
  setTimeout(() => node.classList.remove('swipe-back'), 200);
  if (isReplySwipe(dx, dy)) startReply(node.dataset.mid);
}

// ---- Checklist: "For you" and "For the agent". Only the agent ticks; you can say "I've done this".
const OWNERS = [['user', 'For you', 'Add something for you to do'], ['agent', 'For the agent', 'Add something for the agent to do']];
const mine = i => i.created_by === 'user';
function itemMeta(i) {
  const agent = state.profile.agent.name;
  if (i.done) return `Checked by ${agent}${i.done_at ? ` · ${when(i.done_at)}` : ''}`;
  if (i.claimed_by_user_at) return `Claimed done by you, waiting for ${agent} to check · ${when(i.claimed_by_user_at)}`;
  if (i.unclaim_note) return `${agent} unclaimed this: ${i.unclaim_note}`;
  return '';
}
async function clChange(method, path, body) {
  const d = state.detail; if (!d) return;
  try {
    await api(`threads/${d.id}/checklist${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    state.clEdit = null; state.clShown = '';
    await Promise.all([loadThread(d.id, { quiet: true }), refreshList()]);
    drawChecklist(state.detail, true); showError($('cl-error'), '');
  } catch (error) { showError($('cl-error'), error.message); }
}
function itemNode(i) {
  const agent = state.profile.agent.name;
  const boxLabel = i.done ? `Checked by ${agent}` : i.claimed_by_user_at ? `Claimed done, waiting for ${agent} to check` : 'Not checked yet';
  const box = el('span', { class: `box${i.done ? ' on' : i.claimed_by_user_at ? ' claimed' : ''}`, role: 'img', 'aria-label': boxLabel, text: i.done ? '✓' : i.claimed_by_user_at ? '…' : '' });
  let text;
  if (state.clEdit === i.id) {
    text = el('input', { type: 'text', class: 'cl-edit', maxlength: '300', 'aria-label': 'Item text' });
    text.value = i.text;
    text.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (text.value.trim()) clChange('PATCH', `/${i.id}`, { text: text.value }); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); state.clEdit = null; state.clShown = ''; drawChecklist(state.detail); } });
    queueMicrotask(() => { text.focus(); text.select(); });
  } else text = el('span', { class: 'cl-text', text: i.text });
  const meta = itemMeta(i);
  const actions = el('div', { class: 'cl-actions' });
  const frozen = state.detail?.read_only === true; // an updates thread takes nothing from the user
  if (frozen) return el('li', { class: `cl-item${i.done ? ' is-done' : ''}`, 'data-item': i.id }, box, el('div', { class: 'cl-main' }, text, ...(meta ? [el('span', { class: 'cl-meta', text: meta })] : [])));
  if (!i.done && !i.claimed_by_user_at) actions.append(el('button', { type: 'button', onclick: () => clChange('PATCH', `/${i.id}`, { claimed: true }) }, "I've done this"));
  if (!i.done && i.claimed_by_user_at) actions.append(el('button', { type: 'button', onclick: () => clChange('PATCH', `/${i.id}`, { claimed: false }) }, 'Undo claim'));
  if (mine(i) && state.clEdit !== i.id) actions.append(el('button', { type: 'button', 'aria-label': `Edit: ${i.text}`, onclick: () => { state.clEdit = i.id; state.clShown = ''; drawChecklist(state.detail); } }, 'Edit'),
    el('button', { type: 'button', 'aria-label': `Delete: ${i.text}`, onclick: () => clChange('DELETE', `/${i.id}`) }, 'Delete'));
  return el('li', { class: `cl-item${i.done ? ' is-done' : ''}`, 'data-item': i.id }, box, el('div', { class: 'cl-main' }, text, ...(meta ? [el('span', { class: 'cl-meta', text: meta })] : [])), actions);
}
function listNode(owner, title, items) {
  const mineItems = items.filter(i => i.owner === owner);
  return el('section', { class: 'cl-list', 'data-owner': owner }, el('h4', { class: 'cl-sec' }, title, el('small', { text: mineItems.length ? ` ${mineItems.filter(i => i.done).length} of ${mineItems.length}` : '' })),
    el('ul', {}, ...mineItems.map(itemNode)), ...(mineItems.length ? [] : [el('p', { class: 'hint', text: 'Nothing here yet.' })]));
}
// Panel layout. Wide (>= 900px): a column beside the messages that Hide collapses to a slim tab, remembered per thread.
// Narrow: a "Checklist 2/11" button in the thread header that opens the same panel as a bottom sheet (a dialog).
const narrowQuery = '(max-width: 899px)';
const isNarrow = () => matchMedia(narrowQuery).matches;
const sheetOpen = () => state.sheet && isNarrow();
const clCount = d => { const c = d.checklist || { total: 0, done: 0 }; return c.total ? `${c.done}/${c.total}` : ''; };
function panelWanted(d) { return !!d && !(d.read_only && !(d.checklist_items || []).length); } // an updates thread with no items has nothing to show
function panelOpen(d) { // wide only
  const pref = state.clPref[d.id];
  return pref === 'open' || (pref === undefined && (d.checklist_items || []).length > 0);
}
function setPanel(d, open) { state.clPref[d.id] = open ? 'open' : 'hidden'; saveClPref(); applyLayout(d); }
let sheetReturn = null;
function openSheet() {
  const d = state.detail; if (!d || !panelWanted(d) || !isNarrow() || state.sheet) return;
  state.sheet = true; sheetReturn = $('cl-btn'); applyLayout(d);
  $('cl-close').focus();
}
function closeSheet(restore = true) {
  if (!state.sheet) return;
  state.sheet = false; $('checklist').style.transform = ''; if (state.detail) applyLayout(state.detail);
  if (restore && !$('cl-btn').hidden) $('cl-btn').focus();
}
function applyLayout(d) {
  const panel = $('checklist'), want = panelWanted(d), narrow = isNarrow();
  if (!want || !narrow) state.sheet = false;
  const sheet = want && narrow && state.sheet;
  const open = want && !narrow && panelOpen(d);
  panel.hidden = !(open || sheet);
  panel.classList.toggle('sheet', sheet);
  if (sheet) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); } else { panel.setAttribute('role', 'region'); panel.removeAttribute('aria-modal'); }
  $('cl-backdrop').hidden = !sheet;
  $('thread-main').inert = sheet;
  $('app').querySelector('.list').inert = sheet; document.querySelector('#open > .thread-head').inert = sheet;
  const count = clCount(d);
  const tab = $('cl-tab');
  tab.hidden = !(want && !narrow && !open);
  tab.replaceChildren(donutNode(d.checklist || { total: 0 }), `Checklist${count ? ` ${count}` : ''} ‹`);
  tab.setAttribute('aria-label', `Show checklist${count ? `, ${count} done` : ''}`);
  $('cl-hide').setAttribute('aria-expanded', String(open)); $('cl-hide').hidden = narrow; $('cl-close').hidden = !narrow;
  const btn = $('cl-btn');
  btn.hidden = !(want && narrow);
  btn.replaceChildren(donutNode(d.checklist || { total: 0 }), el('span', { class: 'cl-word', text: 'Checklist' }), el('span', { class: 'cl-n', text: count ? ` ${count}` : '' }));
  btn.setAttribute('aria-expanded', String(sheet));
  $('cl-foot').hidden = d.read_only === true;
}
function drawChecklist(d, force = false) {
  if (!d) { $('checklist').hidden = true; $('cl-tab').hidden = true; $('cl-btn').hidden = true; $('cl-backdrop').hidden = true; return; }
  applyLayout(d);
  const items = d.checklist_items || [];
  const key = JSON.stringify([d.id, items, state.clEdit, state.profile.agent.name, d.read_only === true]);
  if (key === state.clShown) return;
  const typing = $('cl-body').contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (typing && !force) return; // never pull the field out from under the user; the next poll catches up
  state.clShown = key;
  const c = d.checklist || { total: 0, done: 0, claimed: 0 };
  $('cl-summary').textContent = c.total ? `· ${c.done} of ${c.total}` : '· no items yet';
  $('cl-donut').replaceChildren(donutNode(c));
  const bar = $('cl-progress'); bar.setAttribute('aria-valuemax', String(c.total)); bar.setAttribute('aria-valuenow', String(c.done)); bar.setAttribute('aria-valuetext', donutLabel(c));
  bar.firstElementChild.style.width = c.total ? `${Math.round((c.done / c.total) * 100)}%` : '0%';
  $('cl-body').replaceChildren(...OWNERS.map(([o, title]) => listNode(o, title, items)));
}
function setOwner(owner) {
  state.clOwner = owner;
  $('cl-owner-agent').setAttribute('aria-pressed', String(owner === 'agent')); $('cl-owner-user').setAttribute('aria-pressed', String(owner === 'user'));
  $('cl-add').placeholder = OWNERS.find(o => o[0] === owner)[2];
}
function focusAdd(owner) {
  const d = state.detail; if (!d || d.read_only) return false;
  setOwner(owner);
  if (isNarrow()) { openSheet(); } else if (!panelOpen(d)) setPanel(d, true);
  $('cl-add').focus(); return true;
}
function toggleChecklist() {
  const d = state.detail; if (!d || !panelWanted(d)) return;
  if (isNarrow()) { if (state.sheet) closeSheet(); else openSheet(); } else setPanel(d, !panelOpen(d));
}
const hiddenWithin = (n, root) => { for (let x = n; x && x !== root; x = x.parentElement) if (x.hidden) return true; return false; };
function trapTab(e) { // keep Tab inside the sheet while it is open
  if (!sheetOpen() || e.key !== 'Tab') return;
  const nodes = [...$('checklist').querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled && !hiddenWithin(n, $('checklist')));
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (!$('checklist').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
let sheetDrag = null; // swipe down on the sheet header to close it
function dragStart(e) { if (!sheetOpen() || e.target.closest('button')) return; sheetDrag = { y: e.touches[0].clientY, dy: 0 }; }
function dragMove(e) { if (!sheetDrag) return; sheetDrag.dy = Math.max(0, e.touches[0].clientY - sheetDrag.y); $('checklist').style.transform = `translateY(${sheetDrag.dy}px)`; }
function dragEnd() { if (!sheetDrag) return; const far = sheetDrag.dy > 70; sheetDrag = null; if (far) closeSheet(); else $('checklist').style.transform = ''; }

// A read-only thread only carries updates: no composer, and a note saying why.
function drawReadOnly(d) {
  const ro = d.read_only === true;
  $('composer').hidden = ro; $('ro-badge').hidden = !ro; $('ro-note').hidden = !ro;
  if (ro) $('ro-note').replaceChildren(el('strong', { text: 'Updates only. ' }), `${state.profile.agent.name} posts here and you can't reply. To talk, start a new thread.`);
}

// ---- Pin button in the thread header
function drawPinThread() {
  const on = state.openId && isPinned('thread', state.openId);
  $('pin-thread').replaceChildren(on ? 'Unpin' : 'Pin', kbd('P'));
  $('pin-thread').setAttribute('aria-pressed', String(!!on));
}

// ---- Reminders: nudges for the agent, set per thread. A read-only thread takes them too, because they are for the agent.
let remindFor = null;
const REMIND = { every: ['Every', 'like 2h or 1d: fires only if the thread had activity', '2h'], after_agent_replies: ['After this many agent replies with no tick or new item', 'a number, like 3', '3'], idle: ['When the thread has waited on the agent for', 'like 1h', '1h'] };
const kindText = r => (r.kind === 'every' ? `Every ${r.value}` : r.kind === 'idle' ? `After waiting ${r.value}` : `After ${r.value} agent repl${r.value === 1 ? 'y' : 'ies'} with no checklist change`);
function drawReminderForm() {
  const [label, hint, example] = REMIND[$('remind-kind').value];
  $('remind-value-l').textContent = label; $('remind-value').placeholder = example; $('remind-value-hint').textContent = hint;
}
async function drawReminders() {
  const v = await api(`threads/${remindFor}/reminders`);
  $('remind-default').checked = v.default.on; $('remind-default').disabled = v.default.global_off;
  $('remind-default-note').textContent = v.default.global_off ? 'Turned off for the whole server.' : 'When the agent has open items: after 3 replies with no tick, or every 6 hours of activity.';
  $('remind-list').replaceChildren(...(v.items.length ? v.items.map(r => el('li', {}, el('span', { class: 'what' }, el('strong', { text: kindText(r) }), el('small', { text: r.say })),
    el('button', { type: 'button', 'aria-label': `Remove the reminder: ${r.say}`, onclick: () => removeReminder(r.id) }, 'Remove'))) : [el('li', { class: 'hint', text: 'No reminders of your own on this thread.' })]));
}
async function openReminders() {
  const d = state.detail; if (!d) return;
  remindFor = d.id; showError($('remind-error'), ''); $('remind-say').value = ''; $('remind-value').value = ''; drawReminderForm();
  try { await drawReminders(); } catch (error) { showError($('remind-error'), error.message); }
  $('remind-dialog').showModal();
}
async function removeReminder(rid) {
  try { await api(`threads/${remindFor}/reminders/${rid}`, { method: 'DELETE' }); await drawReminders(); showError($('remind-error'), ''); } catch (error) { showError($('remind-error'), error.message); }
}
async function addReminder(event) {
  event.preventDefault();
  try {
    await post(`threads/${remindFor}/reminders`, { kind: $('remind-kind').value, value: $('remind-kind').value === 'after_agent_replies' ? Number($('remind-value').value) : $('remind-value').value.trim(), say: $('remind-say').value });
    $('remind-say').value = ''; $('remind-value').value = ''; showError($('remind-error'), ''); await drawReminders();
  } catch (error) { showError($('remind-error'), error.message); }
}
async function setDefaultReminder() {
  try { await post(`threads/${remindFor}/reminders/default`, { on: $('remind-default').checked }); showError($('remind-error'), ''); } catch (error) { showError($('remind-error'), error.message); $('remind-default').checked = !$('remind-default').checked; }
}

// ---- Merge: fold this thread into another
let mergeFor = null;
function openMerge() {
  const d = state.detail; if (!d) return;
  mergeFor = d.id; mergeTarget = null; $('merge-confirm').hidden = true; showError($('merge-error'), ''); $('merge-q').value = ''; drawMergeList(); $('merge-dialog').showModal(); $('merge-q').focus();
}
function drawMergeList() {
  const q = $('merge-q').value.trim().toLowerCase();
  const rows = state.threads.filter(t => t.id !== mergeFor && !t.merged_into && t.title.toLowerCase().includes(q)).sort(rank).slice(0, 40);
  $('merge-list').replaceChildren(...(rows.length ? rows.map(t => el('li', {}, el('button', { type: 'button', class: 'merge-pick', onclick: () => askMerge(t) },
    el('span', { class: 't', text: t.title }), el('small', { text: `${PILL[t.waiting]} · ${when(t.last_message_at)}` }))))
    : [el('li', { class: 'hint', text: 'No other thread matches.' })]));
}
let mergeTarget = null;
function askMerge(target) { // a merge cannot be undone, so ask once more
  mergeTarget = target; showError($('merge-error'), '');
  $('merge-confirm-text').textContent = `Merge "${state.detail.title}" into "${target.title}"? This cannot be undone.`;
  $('merge-confirm').hidden = false; $('merge-go').focus();
}
async function doMerge(target) {
  const d = state.detail; if (!d) return;
  try {
    await post(`threads/${d.id}/merge`, { into: target.id });
    $('merge-dialog').close(); state.captureFor = null;
    await refreshList(); location.hash = `#/${target.id}`;
  } catch (error) { showError($('merge-error'), error.message); }
}
function drawThread() {
  const d = state.detail;
  $('app').classList.toggle('has-thread', !!d || state.metricsOn || state.trackerOn);
  $('placeholder').style.display = d || state.metricsOn || state.trackerOn ? 'none' : '';
  $('tracker').style.display = state.trackerOn ? 'flex' : 'none';
  $('tracker-link').setAttribute('aria-current', state.trackerOn ? 'page' : 'false');
  $('open').style.display = d ? 'flex' : 'none';
  $('metrics').style.display = state.metricsOn ? 'flex' : 'none';
  $('metrics-link').setAttribute('aria-current', state.metricsOn ? 'page' : 'false');
  if (!d) return;
  drawReadOnly(d);
  $('title').textContent = d.title;
  document.title = `${d.title} · Feedback inbox`;
  $('toggle-done').replaceChildren(d.status === 'done' ? 'Reopen' : 'Mark done', kbd('E'));
  if (state.captureFor !== d.id) { drawCapture(d); state.captureFor = d.id; }
  $('merge-open').hidden = !!d.merged_into || d.read_only === true;
  drawPinThread(); drawChecklist(d);
  drawMessages(d); drawReplyBar();
}
async function loadThread(id, { quiet = false } = {}) {
  try {
    const d = await api(`threads/${id}`);
    if (id !== state.openId) return;
    state.detail = d; drawThread(); if (state.focusItem) focusItemNow();
    if (d.last_author === 'agent' && (!d.user_read_at || d.user_read_at < d.last_message_at)) { // ticks need the read marker even for FYIs
      // Stamp what we actually showed, so a message that arrived since is not marked read unseen.
      await post(`threads/${id}/read`, { seen: d.last_message_at });
      if (id === state.openId && state.detail === d) { d.user_read_at = d.last_message_at; d.unread_for_user = false; drawThread(); }
      await refreshList();
    }
  } catch (error) {
    if (quiet) return;
    state.detail = null; drawThread(); $('placeholder').textContent = `Could not open that thread: ${error.message}`;
  }
}
function route() {
  const [, raw = null, item = null] = /^#\/([\w-]+)(?:\/(c\d+))?$/.exec(location.hash) || [];
  const metrics = raw === 'metrics', tracker = raw === 'tracker', id = metrics || tracker ? null : raw;
  state.focusItem = id && item ? item : null;
  if (id === state.openId && metrics === state.metricsOn && tracker === state.trackerOn) { if (state.focusItem && state.detail) focusItemNow(); return; }
  state.metricsOn = metrics; state.trackerOn = tracker;
  state.openId = id; state.detail = null; state.sheet = false; state.msgStop = null; $('cl-add').value = ''; state.shown = ''; state.clShown = ''; state.clEdit = null; state.captureFor = null; state.images = []; state.gallery = []; state.replyTo = null; $('replybar').hidden = true; state.secrets.clear(); state.replacing.clear(); closeMenu(false);
  $('text').value = ''; growText(); drawPreviews($('previews'), state.images, noop); showError($('error'), '');
  $('placeholder').textContent = 'Select a thread, or start a new one.';
  drawThread(); drawList(); drawPinThread();
  if (id) loadThread(id);
  if (metrics) loadMetrics();
  if (tracker) loadTracker();
}

// ---- Tracker: every checklist item across the threads, grouped For you, For the agent and Done recently.
function focusItemNow() { const id = state.focusItem; state.focusItem = null; if (id) setTimeout(() => jumpToItem(id), 0); }
function trackerRow(r) {
  const i = r.item, st = stateOf(i), agent = state.profile.agent.name;
  const box = el('span', { class: `box${st === 'done' ? ' on' : st === 'claimed' ? ' claimed' : ''}`, role: 'img', 'aria-label': st === 'done' ? `Ticked by ${agent}` : st === 'claimed' ? `Claimed done, waiting for ${agent} to check` : 'Open', text: st === 'done' ? '✓' : st === 'claimed' ? '…' : '' });
  const label = st === 'done' ? 'Ticked' : st === 'claimed' ? 'Claimed' : 'Open';
  const meta = el('span', { class: 'cl-meta' }, el('a', { href: `#/${r.thread}/${i.id}`, text: r.title }), ` · ${label} · ${ageOf(i.created_at)} old`);
  const node = el('li', { class: `tr-item${st === 'done' ? ' is-done' : ''}`, 'data-thread': r.thread, 'data-item': i.id, 'data-state': st }, box, el('div', { class: 'cl-main' }, el('span', { class: 'cl-text', text: plainText(i.text) }), meta));
  if (st !== 'done' && !r.read_only) node.append(el('div', { class: 'cl-actions' }, st === 'open'
    ? el('button', { type: 'button', onclick: () => trackerClaim(r, true) }, "I've done this") : el('button', { type: 'button', onclick: () => trackerClaim(r, false) }, 'Undo claim')));
  return node;
}
async function trackerClaim(r, claimed) {
  try { await api(`threads/${r.thread}/checklist/${r.item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimed }) }); await Promise.all([loadTracker(), refreshList()]); }
  catch (error) { showError($('error'), error.message); $('tr-summary').textContent = error.message; }
}
function drawTracker() {
  const t = state.tdata, f = state.tfilter; if (!t) return;
  const key = JSON.stringify([t, f, state.tDoneOpen, state.profile.agent.name]);
  if (key === state.tdrawn) return;
  state.tdrawn = key;
  const c = t.counts;
  $('tr-donut').replaceChildren(donutNode(c, 40));
  $('tr-summary').textContent = c.total ? `${c.done} of ${c.total} done, ${c.claimed} claimed, ${c.total - c.done - c.claimed} open across ${t.threads.length} thread${t.threads.length === 1 ? '' : 's'}` : 'No checklist items yet.';
  const sel = $('tr-thread'), want = ['', ...t.threads.map(x => x.id)].join();
  if (sel.dataset.have !== want) { sel.replaceChildren(el('option', { value: '', text: 'All threads' }), ...t.threads.map(x => el('option', { value: x.id, text: `${x.title} (${x.open} open)` }))); sel.dataset.have = want; sel.value = f.thread; }
  const keep = rows => filterRows(rows, f);
  const section = (title, rows, extra) => el('section', { class: 'tr-section', 'data-group': title }, el('h3', {}, ...(extra ? [extra] : [title]), el('small', { text: ` ${rows.length}` })),
    ...(extra && !state.tDoneOpen ? [] : [rows.length ? el('ul', { class: 'cl-list-plain', style: 'list-style:none;margin:0;padding:0' }, ...rows.map(trackerRow)) : el('p', { class: 'hint', text: 'Nothing here.' })]));
  const fold = el('button', { type: 'button', 'aria-expanded': String(state.tDoneOpen), onclick: () => { state.tDoneOpen = !state.tDoneOpen; drawTracker(); } }, `${state.tDoneOpen ? '▾' : '▸'} Done recently (last 7 days)`);
  $('tr-groups').replaceChildren(section('For you', keep(t.you)), section('For the agent', keep(t.agent)), section('Done recently', keep(t.done_recent), fold));
}
async function loadTracker() {
  try { state.tdata = await api('tracker'); if (state.trackerOn) drawTracker(); }
  catch (error) { if (!state.tdata) $('tr-groups').replaceChildren(el('p', { class: 'error', text: `Could not load the tracker: ${error.message}` })); }
}
function trackerFilters() {
  state.tfilter = { thread: $('tr-thread').value, state: $('tr-state').value, q: $('tr-q').value }; drawTracker();
}
$('tr-q').addEventListener('input', trackerFilters); $('tr-thread').addEventListener('change', trackerFilters); $('tr-state').addEventListener('change', trackerFilters);
$('tracker-back').addEventListener('click', () => { location.hash = '#/'; });

// ---- Metrics: hand-rolled SVG, no libraries. Days and hours are UTC (the server says so too).
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...kids);
  return node;
}
const WINDOWS = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['all', 'All time']];
function duration(ms) {
  if (ms === null || ms === undefined) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
function niceTop(max) {
  const pow = 10 ** Math.floor(Math.log10(max)), f = max / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}
// rows: [{label, tip, values: {key: n}}]; series: [{key, label}] (class s-<key>). Stacked bars sit on top of each other, otherwise side by side.
function barChart(host, { title, rows, series, stacked, summary }) {
  const W = Math.max(260, Math.floor(host.clientWidth - 22) || 560), H = 176, m = { l: 30, r: 4, t: 8, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const total = r => (stacked ? series.reduce((a, s) => a + (r.values[s.key] || 0), 0) : Math.max(0, ...series.map(s => r.values[s.key] || 0)));
  const top = niceTop(Math.max(1, ...rows.map(total)));
  const y = v => m.t + ph - (v / top) * ph;
  const slot = pw / Math.max(1, rows.length), bw = Math.max(2, Math.min(30, slot * 0.72));
  const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title}. ${summary}` });
  for (const v of top % 2 === 0 && top > 2 ? [0, top / 2, top] : [0, top]) {
    root.append(svg('line', { class: v === 0 ? 'base' : 'grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }), svg('text', { x: m.l - 5, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
  }
  const every = Math.max(1, Math.ceil(46 / slot));
  rows.forEach((r, i) => {
    const x0 = m.l + i * slot + (slot - bw) / 2;
    const g = svg('g', {}, svg('title', {}, r.tip));
    let acc = 0;
    series.forEach((s, si) => {
      const v = r.values[s.key] || 0;
      if (!v) return;
      const w = stacked ? bw : bw / series.length;
      const x = stacked ? x0 : x0 + si * w;
      const from = stacked ? acc : 0;
      g.append(svg('rect', { class: `s-${s.key}`, x, y: y(from + v), width: Math.max(1, w - (stacked ? 0 : 1)), height: Math.max(1, y(from) - y(from + v)), rx: 2 }));
      acc += v;
    });
    // a wider invisible target, so thin bars still show their tooltip
    g.append(svg('rect', { x: m.l + i * slot, y: m.t, width: slot, height: ph, fill: 'transparent' }));
    root.append(g);
    if (i % every === 0) root.append(svg('text', { x: x0 + bw / 2, y: H - 7, 'text-anchor': 'middle' }, r.label));
  });
  return root;
}
const legend = series => el('span', { class: 'legend' }, ...series.map(s => el('span', {}, el('i', { class: `sw s-${s.key}` }), s.label)));
function chartCard(title, series, build) {
  const card = el('section', { class: 'chart' }, el('h4', {}, title, legend(series)));
  queueMicrotask(() => card.append(build(card)));
  return card;
}
const shortDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' });
const tile = (big, label, extra = {}) => el('div', { class: `tile${extra.wide ? ' wide' : ''}` }, el('div', { class: 'big', text: String(big) }), el('div', { class: 'lbl', text: label }));
function statTiles(s) { return el('div', { class: 'tiles four' }, tile(duration(s.median), 'median'), tile(duration(s.mean), 'mean'), tile(duration(s.p90), 'p90'), tile(duration(s.p99), 'p99')); }
function drawMetrics() {
  const m = state.mdata;
  $('winbar').replaceChildren(...WINDOWS.map(([k, label]) => el('button', { type: 'button', 'aria-pressed': String(state.mwindow === k), onclick: () => { state.mwindow = k; state.mdata = null; state.mdrawn = ''; drawMetrics(); loadMetrics(); } }, label)));
  const body = $('metrics-body');
  if (!m) { if (!body.firstChild || state.mdrawn !== 'loading') { body.replaceChildren(el('p', { class: 'sub', text: 'Loading…' })); state.mdrawn = 'loading'; } return; }
  const agent = state.profile.agent.name, you = state.profile.user.name;
  const w = m.workload, v = m.velocity;
  const pair = [{ key: 'user', label: you }, { key: 'agent', label: agent }];
  const wlabel = { '24h': 'the last 24 hours', '7d': 'the last 7 days', all: 'all time' }[m.window];
  const oldest = w.oldest_waiting;
  const sections = [
    el('h3', { text: 'Workload now' }),
    el('div', { class: 'tiles' }, tile(w.open, `open threads, of ${w.threads}`), tile(w.waiting_agent, `waiting for ${agent}`), tile(w.waiting_you, 'waiting on you'),
      tile(w.checklist.open, 'checklist items open'), tile(w.checklist.claimed, 'claimed, waiting for a check'), tile(w.checklist.ticked, 'checklist items ticked'),
      el('div', { class: 'tile wide' }, el('div', { class: 'lbl', text: 'Oldest waiting thread' }),
        oldest ? el('div', {}, el('a', { href: `#/${oldest.id}`, text: oldest.title }), el('div', { class: 'big', text: duration(oldest.age_ms) }), el('div', { class: 'lbl', text: `waiting for ${oldest.waiting === 'agent' ? agent : 'you'}` }))
          : el('div', { class: 'big', text: 'None' }))),
    el('h3', { text: 'Velocity' }),
    el('p', { class: 'sub', text: `${wlabel}: ${v.messages.user} from you, ${v.messages.agent} from ${agent}; ${v.opened} threads opened, ${v.closed} closed.` }),
    chartCard('Messages per day', pair, host => barChart(host, { title: 'Messages per day', series: pair, stacked: true, summary: `${v.messages.user} from you and ${v.messages.agent} from ${agent} over ${v.per_day.length} days`,
      rows: v.per_day.map(d => ({ label: shortDay(d.day), tip: `${shortDay(d.day)}: ${d.user} from you, ${d.agent} from ${agent}`, values: d })) })),
    chartCard('Messages per hour, last 24 hours', pair, host => barChart(host, { title: 'Messages per hour in the last 24 hours', series: pair, stacked: true,
      summary: `${v.per_hour.reduce((a, h) => a + h.user, 0)} from you and ${v.per_hour.reduce((a, h) => a + h.agent, 0)} from ${agent}`,
      rows: v.per_hour.map(h => { const hh = h.hour.slice(11, 13); return { label: `${hh}:00`, tip: `${h.hour.slice(0, 10)} ${hh}:00 UTC: ${h.user} from you, ${h.agent} from ${agent}`, values: h }; }) })),
    chartCard('Threads opened and closed per day', [{ key: 'opened', label: 'Opened' }, { key: 'closed', label: 'Closed' }], host => barChart(host, { title: 'Threads opened and closed per day',
      series: [{ key: 'opened', label: 'Opened' }, { key: 'closed', label: 'Closed' }], stacked: false, summary: `${v.opened} opened and ${v.closed} closed`,
      rows: v.per_day.map(d => ({ label: shortDay(d.day), tip: `${shortDay(d.day)}: ${d.opened} opened, ${d.closed} closed`, values: d })) })),
    el('h3', { text: 'Response times' }),
    el('p', { class: 'sub', text: `${wlabel}. A run of messages from one side counts from its first message to the other side's next one.` }),
    el('div', { class: 'two' },
      el('div', { class: 'card' }, el('h4', { text: `${agent} replies` }), el('p', { class: 'sub', text: `from your message to its next one, ${m.response.agent.count} samples` }), statTiles(m.response.agent)),
      el('div', { class: 'card' }, el('h4', { text: 'You reply' }), el('p', { class: 'sub', text: `from ${agent}'s message to yours, ${m.response.user.count} samples` }), statTiles(m.response.user))),
    el('h3', { text: 'By area' }),
    el('div', { class: 'tablewrap' }, areaTable(m, agent)),
    el('p', { class: 'sub', style: 'margin-top:14px', text: `Days and hours are UTC. A thread counts as closed when its status last changed to done. Merged-away threads and ${agent}'s acknowledgements are not counted. Your actions: ${m.events.count} in ${wlabel}${m.events.count ? ` (${Object.entries(m.events.by_kind).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')})` : ''}.` }),
  ];
  const key = JSON.stringify([m.window, m.generated_at.slice(0, 16), state.profile, innerWidth]);
  if (key === state.mdrawn) return;
  state.mdrawn = key;
  body.replaceChildren(...sections);
}
function areaTable(m, agent) {
  const head = ['Area', 'Open / all', `Waiting for ${agent}`, 'Waiting on you', `Msgs you / ${agent}`, 'Median reply'];
  const rows = m.areas.map(a => [a.label, `${a.open} / ${a.threads}`, a.waiting_agent, a.waiting_you, `${a.messages_user} / ${a.messages_agent}`, duration(a.agent_response.median)]);
  if (!rows.length) return el('p', { class: 'sub', style: 'padding:10px', text: 'No threads yet.' });
  return el('table', { class: 'areas' }, el('thead', {}, el('tr', {}, ...head.map(t => el('th', { scope: 'col', text: t })))), el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map((c, i) => (i ? el('td', { text: String(c) }) : el('th', { scope: 'row', text: String(c) })))))));
}
async function loadMetrics() {
  try {
    const want = state.mwindow;
    const data = await api(`metrics?window=${want}`);
    if (!state.metricsOn || want !== state.mwindow) return;
    state.mdata = data; drawMetrics();
  } catch (error) { if (!state.mdata) { $('metrics-body').replaceChildren(el('p', { class: 'error', text: `Could not load the metrics: ${error.message}` })); state.mdrawn = ''; } }
}

// ---- Composer
// `/btw question` (or the Side question button) sends a side question: the prefix is dropped and the quote bar, if any, is left alone.
async function send(event, forceAside = false) {
  event.preventDefault();
  const id = state.openId, parsed = parseBtw($('text').value), aside = forceAside || parsed.aside, text = aside ? parsed.text : $('text').value;
  if (state.busy || !id) return;
  if (aside && !text.trim() && !state.images.length) { showError($('error'), 'Write your side question after /btw.'); $('text').focus(); return; }
  if (!text.trim() && !state.images.length) return;
  if (state.detail?.read_only) { showError($('error'), 'This thread is read-only, so nothing can be sent or queued.'); return; }
  const cid = newCid(), written_at = new Date().toISOString(), reply_to = !aside && state.replyTo ? state.replyTo : undefined, images = [...state.images];
  state.busy = true; $('send').disabled = true; $('btw').disabled = true; showError($('error'), '');
  const cleared = () => { if (id === state.openId) { if (!aside) state.replyTo = null; $('text').value = ''; state.images.length = 0; drawPreviews($('previews'), state.images, noop); growText(); } };
  const queue = async () => { // the composer is emptied first, so anything typed while it is stored is not wiped
    const before = $('text').value, replying = state.replyTo; cleared();
    try { await outbox.add({ cid, thread: id, text, images, reply_to, aside, written_at }); } catch (error) { $('text').value = before; state.images.push(...images); state.replyTo = replying; redrawComposer(); throw error; }
    drawReplyBar();
  };
  try {
    // With no signal, or messages already waiting (they go first, to keep the order), the message joins the outbox.
    if (isOffline() || outbox.pending()) { await queue(); return; }
    try {
      await post(`threads/${id}/messages`, { text, images, ...(aside ? { aside: true } : reply_to ? { reply_to } : {}), client_id: cid, written_at });
    } catch (error) { if (error.network) { await queue(); return; } throw error; }
    cleared();
    await Promise.all([loadThread(id), refreshList()]);
  } catch (error) { showError($('error'), error.message); }
  finally { state.busy = false; $('send').disabled = false; $('btw').disabled = false; $('text').focus(); }
}
const redrawComposer = () => drawPreviews($('previews'), state.images, redrawComposer);
async function toggleDone() {
  const d = state.detail; if (!d) return;
  try { await post(`threads/${d.id}/status`, { status: d.status === 'done' ? 'open' : 'done' }); await Promise.all([loadThread(d.id), refreshList()]); }
  catch (error) { showError($('error'), error.message); }
}

// ---- What this server offers: the key box target and whether Redact is on. Unknown (offline, never loaded) draws neither.
async function refreshConfig() {
  try { const c = await api('config'); const next = { secret_target: typeof c.secret_target === 'string' ? c.secret_target : null, redact: c.redact === true }; if (JSON.stringify(next) !== JSON.stringify(state.config)) { state.config = next; if (state.detail) drawMessages(state.detail); } }
  catch { /* keep what we knew */ }
}
// ---- The phone's header ⋯ and composer ＋ menus: the same actions as the desktop buttons.
function openMore() {
  const d = state.detail; if (!d) return;
  openMenu($('more'), [{ label: isPinned('thread', d.id) ? 'Unpin' : 'Pin', onclick: () => togglePin('thread', d.id) },
    ...(!d.merged_into && !d.read_only ? [{ label: 'Merge into…', onclick: openMerge }] : []),
    { label: 'Reminders', onclick: openReminders },
    { label: d.status === 'done' ? 'Reopen' : 'Mark done', onclick: toggleDone },
    ...(COARSE && document.querySelector('.fb-launcher') ? [{ label: 'Feedback on this page', onclick: () => document.querySelector('.fb-launcher')?.click() }] : []),
    ...(d.read_only ? [{ note: "Read-only: updates only. You can't reply here." }] : []), ...(d.merged_into ? [{ note: 'This thread was merged into another one.' }] : [])]);
}
function openPlus() {
  openMenu($('plus'), [{ label: 'Attach image', onclick: () => $('file').click() }, { label: 'Side question', onclick: startAside }], { up: true });
}
// The text box grows with what is typed, up to about five lines, on a phone. On a wide screen it stays as it was.
function growText() {
  const t = $('text');
  if (!isPhone()) { t.style.height = ''; t.removeAttribute('rows'); return; }
  t.rows = 1; t.style.height = 'auto';
  const cap = parseFloat(getComputedStyle(t).maxHeight);
  t.style.height = `${Math.min(t.scrollHeight, Number.isFinite(cap) ? cap : 140)}px`;
}
// The page follows the visual viewport, so an open keyboard shrinks the layout (and the list keeps the rest) instead of covering the composer.
function fitViewport() {
  const vv = window.visualViewport; if (!vv) return;
  const root = document.documentElement, kb = innerHeight - vv.height > 150, was = root.classList.contains('kb');
  root.style.setProperty('--vvh', `${Math.round(vv.height)}px`); root.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`);
  root.classList.toggle('kb', kb);
  if (state.atBottom || kb !== was) requestAnimationFrame(() => { if (state.atBottom) $('scroll').scrollTop = $('scroll').scrollHeight; });
  placeMenu();
}

// ---- New thread dialog
const redrawNew = () => drawPreviews($('new-previews'), state.newImages, redrawNew);
async function startThread(event) {
  event.preventDefault();
  showError($('new-error'), '');
  try {
    const { id } = await post('threads', { title: $('new-title').value, text: $('new-text').value, images: state.newImages });
    $('new-dialog').close(); $('new-form').reset(); state.newImages.length = 0; redrawNew();
    await refreshList(); location.hash = `#/${id}`;
  } catch (error) { showError($('new-error'), error.message); }
}
function openNew() { showError($('new-error'), ''); $('new-dialog').showModal(); $('new-title').focus(); }

// ---- Keyboard
const typing = t => !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
const anyDialog = () => [...document.querySelectorAll('dialog')].some(d => d.open);
function onKey(e) {
  if (e.isComposing) return;
  if (!$('popmenu').hidden) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const b = [...$('popmenu').querySelectorAll('button:not(:disabled)')], i = b.indexOf(document.activeElement); b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus(); } else if (e.key === 'Tab') closeMenu(false); return; }
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  if (mod && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (mod && !e.shiftKey && e.code === 'KeyI') {
    if ($('new-dialog').open) { e.preventDefault(); $('new-file').click(); } else if (state.openId && !anyDialog() && !state.detail?.read_only) { e.preventDefault(); $('file').click(); }
    return;
  }
  if (mod) return;
  if (e.key === 'Escape' && sheetOpen() && !anyDialog()) { e.preventDefault(); closeSheet(); return; }
  if (lightOpen()) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); flip(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); flip(1); }
    return;
  }
  if (e.key === 'Escape' && e.target === $('search')) { $('search').value = ''; state.q = ''; $('search').blur(); refreshList(); return; }
  if (typing(e.target) || anyDialog() || e.altKey) return;
  const tag = e.target.tagName;
  const q = activeQuestion();
  if (q && /^[1-9]$/.test(e.key) && Number(e.key) <= q.options.length) { e.preventDefault(); toggleOption(q, q.options[Number(e.key) - 1].id); return; }
  if (q && e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') {
    const s = selFor(q);
    if (s.ids.length || s.other.trim()) { e.preventDefault(); submitAnswer(q); return; }
  }
  if (e.key === '?') { e.preventDefault(); $('help-dialog').showModal(); return; }
  if (e.shiftKey) return;
  if (e.target.classList?.contains('msg') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) { e.preventDefault(); moveMsg(e.target, e.key === 'Home' ? 'start' : e.key === 'End' ? 'end' : e.key === 'ArrowDown' ? 1 : -1); return; }
  if (e.key === 'l' && state.detail) { e.preventDefault(); toggleChecklist(); return; }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
  else if (e.key === 'e' && state.detail) { e.preventDefault(); toggleDone(); }
  else if (e.key === 'n') { e.preventDefault(); openNew(); }
  else if (e.key === 'p' && state.openId) { e.preventDefault(); togglePin('thread', state.openId); }
  else if (e.key === 'b' && state.detail && !state.detail.read_only) { e.preventDefault(); startAside(); }
  else if (e.key === 'r' && state.detail && !state.detail.read_only && e.target.closest?.('.msg[data-mid]')) { e.preventDefault(); startReply(e.target.closest('.msg').dataset.mid); }
  else if ((e.key === 'c' || e.key === 'y') && state.detail) { e.preventDefault(); focusAdd(e.key === 'c' ? 'agent' : 'user'); }
}

// ---- Wiring
paintKeys();
$('help-rows').replaceChildren(...SHORTCUTS.map(([k, what]) => el('tr', {}, el('td', {}, ...k.split(' / ').flatMap((part, i) => [...(i ? [' or '] : []), kbd(part)])), el('td', { text: what }))));
$('composer').addEventListener('submit', send);
$('more').addEventListener('click', openMore);
$('plus').addEventListener('click', openPlus);
$('text').addEventListener('input', growText);
$('text').addEventListener('focus', () => { if (state.atBottom) setTimeout(() => { $('scroll').scrollTop = $('scroll').scrollHeight; }, 250); });
$('scroll').addEventListener('scroll', () => { const s = $('scroll'); state.atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 80; placeMenu(); }, { passive: true });
document.addEventListener('pointerdown', e => { const m = $('popmenu'); if (!m.hidden && !m.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu(false); });
window.visualViewport?.addEventListener('resize', fitViewport); window.visualViewport?.addEventListener('scroll', fitViewport);
$('redact-cancel').addEventListener('click', () => $('redact-dialog').close());
$('redact-go').addEventListener('click', doRedact);
if (COARSE) $('text').placeholder = 'Message';
window.addEventListener('online', () => { setOffline(false); drawOffline(); outbox.flush(); poll(); });
window.addEventListener('offline', () => { setOffline(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) outbox.flush(); });
// The saved copy of the page and the last thread data, so the inbox opens with no signal. Only where the browser allows it (https or localhost).
try { navigator.serviceWorker?.register('sw.js'); } catch { /* no service worker here */ }
$('btw').addEventListener('click', e => { if (!$('text').value.trim() && !state.images.length) { startAside(); return; } send(e, true); });
$('text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit(); } else if (e.key === 'Escape' && state.replyTo) { e.preventDefault(); cancelReply(); } });
$('replybar-x').addEventListener('click', () => { cancelReply(); $('text').focus(); });
$('msgs').addEventListener('touchstart', swipeStart, { passive: true });
$('msgs').addEventListener('touchmove', swipeMove, { passive: true });
$('msgs').addEventListener('touchend', swipeEnd);
$('msgs').addEventListener('touchcancel', () => { if (swipe.node) { swipe.node.classList.remove('swiping'); swipe.node.style.transform = ''; swipe.node = null; } });
$('text').addEventListener('paste', e => { const files = pastedImages(e); if (files.length) { e.preventDefault(); addImages(state.images, files, $('error'), redrawComposer); } });
$('attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', e => { addImages(state.images, [...e.target.files], $('error'), redrawComposer); e.target.value = ''; });
$('toggle-done').addEventListener('click', toggleDone);
$('pin-thread').addEventListener('click', () => { if (state.openId) togglePin('thread', state.openId); });
$('merge-open').addEventListener('click', openMerge);
$('remind-open').addEventListener('click', openReminders);
$('remind-close').addEventListener('click', () => $('remind-dialog').close());
$('remind-kind').addEventListener('change', drawReminderForm);
$('remind-form').addEventListener('submit', addReminder);
$('remind-default').addEventListener('change', setDefaultReminder);
$('merge-cancel').addEventListener('click', () => $('merge-dialog').close());
$('merge-q').addEventListener('input', drawMergeList);
$('merge-back').addEventListener('click', () => { mergeTarget = null; $('merge-confirm').hidden = true; });
$('merge-go').addEventListener('click', () => { if (mergeTarget) doMerge(mergeTarget); });
$('cl-hide').addEventListener('click', () => { if (state.detail) setPanel(state.detail, false); });
$('cl-tab').addEventListener('click', () => { if (state.detail) { setPanel(state.detail, true); $('cl-hide').focus(); } });
$('cl-btn').addEventListener('click', toggleChecklist);
$('cl-close').addEventListener('click', () => closeSheet());
$('cl-backdrop').addEventListener('click', () => closeSheet());
$('checklist').addEventListener('keydown', trapTab);
for (const o of ['agent', 'user']) $(`cl-owner-${o}`).addEventListener('click', () => { setOwner(o); $('cl-add').focus(); });
$('cl-add').addEventListener('keydown', e => { if (e.key === 'Escape' && !sheetOpen()) { e.stopPropagation(); $('cl-add').blur(); } });
$('cl-foot').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('cl-add').value.trim(); if (!text) return;
  $('cl-add').value = ''; await clChange('POST', '', { owner: state.clOwner, text });
  $('cl-add').focus();
});
$('cl-head').addEventListener('touchstart', dragStart, { passive: true });
$('cl-head').addEventListener('touchmove', dragMove, { passive: true });
$('cl-head').addEventListener('touchend', dragEnd);
$('cl-head').addEventListener('touchcancel', dragEnd);
$('msgs').addEventListener('focusin', e => { const n = e.target.closest?.('.msg[data-mid]'); if (n && n.parentElement === $('msgs')) { state.msgStop = n.dataset.mid; applyStop(); } });
$('back').addEventListener('click', () => { location.hash = '#/'; });
$('metrics-back').addEventListener('click', () => { location.hash = '#/'; });
let resizeTimer;
window.addEventListener('resize', () => { growText(); if (state.detail) applyLayout(state.detail); clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.metricsOn && state.mdata) { state.mdrawn = ''; drawMetrics(); } }, 120); });
$('new-thread').addEventListener('click', openNew);
$('new-cancel').addEventListener('click', () => $('new-dialog').close());
$('new-form').addEventListener('submit', startThread);
$('new-text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('new-form').requestSubmit(); } });
$('new-text').addEventListener('paste', e => { const files = pastedImages(e); if (files.length) { e.preventDefault(); addImages(state.newImages, files, $('new-error'), redrawNew); } });
$('new-attach').addEventListener('click', () => $('new-file').click());
$('new-file').addEventListener('change', e => { addImages(state.newImages, [...e.target.files], $('new-error'), redrawNew); e.target.value = ''; });
for (const b of document.querySelectorAll('[data-filter]')) b.addEventListener('click', () => { state.filter = b.dataset.filter; state.view = null; state.q = ''; $('search').value = ''; refreshList(); });
for (const [id, v] of [['view-agent', 'agent'], ['view-you', 'you']]) $(id).addEventListener('click', () => { state.view = state.view === v ? null : v; drawList(); });
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = $('search').value.trim(); refreshList(); }, 150); });
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('help-close').addEventListener('click', () => $('help-dialog').close());
$('light-close').addEventListener('click', () => $('lightbox').close());
$('light-prev').addEventListener('click', () => flip(-1));
$('light-next').addEventListener('click', () => flip(1));
let touchX = null;
$('lightbox').addEventListener('touchstart', e => { touchX = e.changedTouches[0].clientX; }, { passive: true });
$('lightbox').addEventListener('touchend', e => { if (touchX === null) return; const dx = e.changedTouches[0].clientX - touchX; touchX = null; if (Math.abs(dx) > 50) flip(dx < 0 ? 1 : -1); });
$('me').addEventListener('click', openProfile);
$('profile-form').addEventListener('submit', saveProfile);
$('profile-cancel').addEventListener('click', () => $('profile-dialog').close());
$('profile-name').addEventListener('input', () => { if (profile.pending === undefined && !state.profile.user.avatar) paintAvatarPreview(); });
$('avatar-pick').addEventListener('click', () => $('avatar-file').click());
$('avatar-clear').addEventListener('click', () => { profile.pending = null; paintAvatarPreview(); });
$('avatar-file').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (!TYPES.includes(file.type)) return showError($('profile-error'), 'Use a PNG, JPEG or WebP image.');
  if (file.size > 8 * 1024 * 1024) return showError($('profile-error'), 'Choose a smaller image.');
  try { profile.pending = await cropSquare(file); showError($('profile-error'), ''); paintAvatarPreview(); } catch (error) { showError($('profile-error'), error.message); }
});
document.addEventListener('keydown', onKey);
window.addEventListener('hashchange', route);
async function poll() {
  if (document.visibilityState !== 'visible') return;
  await Promise.all([refreshList(), refreshProfile(), refreshPins(), refreshConfig()]);
  if (state.openId) await loadThread(state.openId, { quiet: true });
  if (state.metricsOn) await loadMetrics();
  if (state.trackerOn) await loadTracker();
}
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);
drawMe();
refreshPins();
fitViewport(); drawOffline(); outbox.start();
Promise.all([refreshProfile(), refreshAreas(), refreshConfig()]).then(refreshList).then(route);
