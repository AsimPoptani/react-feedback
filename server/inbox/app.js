// Feedback inbox. No build, no deps. All text goes through textContent; nothing is injected as HTML.
import { DEFAULT_AREAS, areaLabel, areaOf, sortAreas, subHeading } from './areas.js';
const API = new URL('../api/', location.href).pathname;
const POLL_MS = 10000;
const MAX_IMAGES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const $ = id => document.getElementById(id);

const FOLD_KEY = 'fb-inbox-folds';
const state = { metricsOn: false, mwindow: '7d', mdata: null, mdrawn: '', threads: [], filter: 'all', pins: { threads: [], areas: [] }, areaConfig: DEFAULT_AREAS, expanded: new Set(), clOpen: {}, clDraft: { agent: '', user: '' }, clEdit: null, clShown: '',
  view: null, q: '', openId: null, detail: null, shown: '', images: [], newImages: [], busy: false,
  profile: { user: { name: 'You' }, agent: { name: 'Agent' } }, order: [], gallery: [], galleryAt: 0, qsel: {}, folds: loadFolds() };
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function loadFolds() { try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function saveFolds() { try { localStorage.setItem(FOLD_KEY, JSON.stringify(state.folds)); } catch { /* storage may be blocked */ } }

async function api(path, options) {
  const response = await fetch(API + path, options);
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

// ---- Safe markdown subset: **bold**, *italics*, `code`, "- " lists, [text](http link). Built from text nodes only.
const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/[^\s)]+|#\/[\w-]+)\))/g;
export function inline(text) {
  const frag = document.createDocumentFragment();
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    let m;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) frag.append(el('strong', { text: part.slice(2, -2) }));
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) frag.append(el('code', { text: part.slice(1, -1) }));
    else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) frag.append(el('em', { text: part.slice(1, -1) }));
    else if ((m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part))) frag.append(el('a', { href: m[2], text: m[1], target: '_blank', rel: 'noopener noreferrer' }));
    else if ((m = /^\[([^\]]+)\]\((#\/[\w-]+)\)$/.exec(part))) frag.append(el('a', { href: m[2], text: m[1] })); // a link to another thread
    else frag.append(part);
  }
  return frag;
}
export function markdown(text) {
  const root = el('div', { class: 'text' });
  let list = null;
  let para = [];
  const flush = () => { if (para.length) { const p = el('p'); p.append(inline(para.join('\n'))); root.append(p); para = []; } };
  for (const line of text.split('\n')) {
    const item = /^\s*[-*] +(.*)$/.exec(line);
    if (item) {
      flush();
      if (!list) { list = el('ul'); root.append(list); }
      const li = el('li'); li.append(inline(item[1])); list.append(li);
    } else if (!line.trim()) { flush(); list = null; }
    else { list = null; para.push(line); }
  }
  flush();
  return root;
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
  ['C', 'Add a checklist item for the agent'], ['Y', 'Add a checklist item for you'],
  ['1–9, Enter', 'Pick an option on the latest open question, then answer'], ['← / →', 'Flip images in the viewer'], ['?', 'This cheat sheet'], ['Esc', 'Close the viewer or a dialog']];

// ---- Profile and avatars
function avatar(who, big = false) {
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
  const tally = checklistSummary(t.checklist || { total: 0 });
  state.order.push(t.id);
  const link = el('a', { href: `#/${t.id}`, ...(t.id === state.openId ? { 'aria-current': 'true' } : {}) },
    el('div', { class: 'row-title' }, ...(t.unread_for_user ? [el('span', { class: 'dot', role: 'img', 'aria-label': t.read_only ? 'Unread update' : 'Unread: needs you' })] : []), el('span', { class: 't', text: t.title })),
    el('div', { class: 'meta' }, t.read_only && t.status !== 'done' ? el('span', { class: 'pill upd', text: 'Updates' }) : el('span', { class: `pill ${t.waiting}`, text: PILL[t.waiting] }), ...(badge ? [badge] : []), ...(t.open_question ? [el('span', { class: 'pill q', text: 'Question' })] : []),
      ...(tally ? [el('span', { class: 'tally', text: tally })] : []),
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
const quiet = (d, m) => !d.read_only && m.author === 'agent' && (m.flag === 'fyi' || m.flag === 'done') && !m.question && !m.divider;
const expandKey = (d, m) => `${d.id}:${m.id}`;
function toggleExpanded(d, m) { const k = expandKey(d, m); if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k); state.shown = ''; drawMessages(d); }
function messageNode(d, m) {
  if (m.divider) return el('div', { class: 'divider', role: 'separator' }, el('span', { text: m.text }));
  const who = state.profile[m.author];
  const farewell = d.merged_into && m === d.messages[d.messages.length - 1]; // the link to the merged thread stays visible
  const folded = quiet(d, m) && !farewell && !state.expanded.has(expandKey(d, m));
  const badge = m.author === 'agent' ? flagBadge(m.flag) : null;
  if (folded) {
    const first = (m.text.split('\n').find(l => l.trim()) || (m.images.length ? '[image]' : '')).slice(0, 160);
    return el('article', { class: 'msg agent collapsed', 'aria-label': `${who.name}, ${when(m.created_at)}, ${FLAG[m.flag][0]}` },
      avatar(m.author), ...(badge ? [badge] : []), el('span', { class: 'peek', text: first }), el('time', { datetime: m.created_at, text: when(m.created_at) }),
      el('button', { type: 'button', class: 'show', onclick: () => toggleExpanded(d, m) }, 'Show'));
  }
  const head = el('div', { class: 'who' }, avatar(m.author), el('strong', { text: who.name }), ' · ', el('time', { datetime: m.created_at, text: when(m.created_at) }), ...(badge ? [badge] : []));
  if (quiet(d, m) && !farewell) head.append(el('button', { type: 'button', class: 'show', onclick: () => toggleExpanded(d, m) }, 'Hide'));
  if (m.author === 'user' && d.acked_through === m.created_at) head.append(el('span', { class: 'acked-note', text: `· ${state.profile.agent.name} acknowledged` }));
  const ticks = ticksFor(d, m); if (ticks) head.append(ticks);
  const node = el('article', { class: `msg ${m.author}${m.flag === 'needs_you' ? ' needs' : ''}`, 'aria-label': `${who.name}, ${when(m.created_at)}` }, head);
  if (m.question) node.append(questionCard(d, m)); else if (m.text) node.append(markdown(m.text));
  if (m.images.length) node.append(el('div', { class: 'imgs' }, ...m.images.map((f, i) => imageButton(f, `Image ${i + 1} from ${who.name}`, fileUrl(d.id, f)))));
  return node;
}
function drawMessages(d) {
  const open = [...state.expanded].filter(k => k.startsWith(`${d.id}:`)).sort();
  const key = JSON.stringify([d.id, d.status, d.user_read_at, d.agent_read_at, d.acked_through, state.profile, open, d.messages.map(m => m.id + m.created_at + (m.answer ? 'a' : '') + (m.flag || ''))]);
  state.gallery = buildGallery(d);
  if (key === state.shown) return;
  const first = state.shown === '' || !state.shown.startsWith(`["${d.id}"`);
  const scroll = $('scroll');
  const stick = first || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  state.shown = key;
  $('msgs').replaceChildren(...d.messages.map(m => messageNode(d, m)));
  if (stick) scroll.scrollTop = scroll.scrollHeight;
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
function listNode(owner, title, placeholder, items) {
  const mineItems = items.filter(i => i.owner === owner);
  const input = el('input', { type: 'text', id: `cl-add-${owner}`, maxlength: '300', placeholder, 'aria-label': placeholder });
  input.value = state.clDraft[owner];
  input.addEventListener('input', () => { state.clDraft[owner] = input.value; });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); input.blur(); } });
  const form = el('form', { class: 'cl-add' }, input, el('button', { type: 'submit' }, 'Add'));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    state.clDraft[owner] = ''; await clChange('POST', '', { owner, text });
    $(`cl-add-${owner}`)?.focus();
  });
  return el('section', { class: 'cl-list', 'data-owner': owner }, el('h3', {}, title, el('small', { text: mineItems.length ? `${mineItems.filter(i => i.done).length} of ${mineItems.length}` : '' })),
    el('ul', {}, ...mineItems.map(itemNode)), ...(mineItems.length ? [] : [el('p', { class: 'hint', text: 'Nothing here yet.' })]), ...(state.detail?.read_only ? [] : [form]));
}
function drawChecklist(d, force = false) {
  const box = $('checklist');
  if (!d) { box.hidden = true; return; }
  box.hidden = false;
  const items = d.checklist_items || [];
  const key = JSON.stringify([d.id, items, state.clEdit, state.profile.agent.name, d.read_only === true]);
  if (key === state.clShown) return;
  const typing = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if (typing && !force) return; // never pull the field out from under the user; the next poll catches up
  state.clShown = key;
  const c = d.checklist || { total: 0, done: 0, claimed: 0 };
  $('cl-summary').textContent = c.total ? checklistSummary(c) : 'no items yet';
  if (state.clOpen[d.id] === undefined) state.clOpen[d.id] = items.length > 0 && innerWidth > 759; // on a phone it starts folded
  box.open = !!state.clOpen[d.id];
  $('cl-body').replaceChildren(...OWNERS.map(([o, title, ph]) => listNode(o, title, ph, items)));
}
function focusAdd(owner) {
  const d = state.detail; if (!d || d.read_only) return false;
  state.clOpen[d.id] = true; $('checklist').open = true; drawChecklist(d, true);
  $(`cl-add-${owner}`).focus(); return true;
}

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
  $('app').classList.toggle('has-thread', !!d || state.metricsOn);
  $('placeholder').style.display = d || state.metricsOn ? 'none' : '';
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
  drawMessages(d);
}
async function loadThread(id, { quiet = false } = {}) {
  try {
    const d = await api(`threads/${id}`);
    if (id !== state.openId) return;
    state.detail = d; drawThread();
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
  const raw = (/^#\/([\w-]+)$/.exec(location.hash) || [])[1] || null;
  const metrics = raw === 'metrics', id = metrics ? null : raw;
  if (id === state.openId && metrics === state.metricsOn) return;
  state.metricsOn = metrics;
  state.openId = id; state.detail = null; state.shown = ''; state.clShown = ''; state.clEdit = null; state.captureFor = null; state.images = []; state.gallery = [];
  $('text').value = ''; drawPreviews($('previews'), state.images, noop); showError($('error'), '');
  $('placeholder').textContent = 'Select a thread, or start a new one.';
  drawThread(); drawList(); drawPinThread();
  if (id) loadThread(id);
  if (metrics) loadMetrics();
}

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
async function send(event) {
  event.preventDefault();
  const id = state.openId, text = $('text').value;
  if (state.busy || !id || (!text.trim() && !state.images.length)) return;
  state.busy = true; $('send').disabled = true; showError($('error'), '');
  try {
    await post(`threads/${id}/messages`, { text, images: state.images });
    if (id === state.openId) { $('text').value = ''; state.images.length = 0; drawPreviews($('previews'), state.images, noop); }
    await Promise.all([loadThread(id), refreshList()]);
  } catch (error) { showError($('error'), error.message); }
  finally { state.busy = false; $('send').disabled = false; $('text').focus(); }
}
const redrawComposer = () => drawPreviews($('previews'), state.images, redrawComposer);
async function toggleDone() {
  const d = state.detail; if (!d) return;
  try { await post(`threads/${d.id}/status`, { status: d.status === 'done' ? 'open' : 'done' }); await Promise.all([loadThread(d.id), refreshList()]); }
  catch (error) { showError($('error'), error.message); }
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
  const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
  if (mod && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
  if (mod && !e.shiftKey && e.code === 'KeyI') {
    if ($('new-dialog').open) { e.preventDefault(); $('new-file').click(); } else if (state.openId && !anyDialog() && !state.detail?.read_only) { e.preventDefault(); $('file').click(); }
    return;
  }
  if (mod) return;
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
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
  else if (e.key === 'e' && state.detail) { e.preventDefault(); toggleDone(); }
  else if (e.key === 'n') { e.preventDefault(); openNew(); }
  else if (e.key === 'p' && state.openId) { e.preventDefault(); togglePin('thread', state.openId); }
  else if ((e.key === 'c' || e.key === 'y') && state.detail) { e.preventDefault(); focusAdd(e.key === 'c' ? 'agent' : 'user'); }
}

// ---- Wiring
paintKeys();
$('help-rows').replaceChildren(...SHORTCUTS.map(([k, what]) => el('tr', {}, el('td', {}, ...k.split(' / ').flatMap((part, i) => [...(i ? [' or '] : []), kbd(part)])), el('td', { text: what }))));
$('composer').addEventListener('submit', send);
$('text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('composer').requestSubmit(); } });
$('text').addEventListener('paste', e => { const files = pastedImages(e); if (files.length) { e.preventDefault(); addImages(state.images, files, $('error'), redrawComposer); } });
$('attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', e => { addImages(state.images, [...e.target.files], $('error'), redrawComposer); e.target.value = ''; });
$('toggle-done').addEventListener('click', toggleDone);
$('pin-thread').addEventListener('click', () => { if (state.openId) togglePin('thread', state.openId); });
$('merge-open').addEventListener('click', openMerge);
$('merge-cancel').addEventListener('click', () => $('merge-dialog').close());
$('merge-q').addEventListener('input', drawMergeList);
$('merge-back').addEventListener('click', () => { mergeTarget = null; $('merge-confirm').hidden = true; });
$('merge-go').addEventListener('click', () => { if (mergeTarget) doMerge(mergeTarget); });
$('checklist').addEventListener('toggle', () => { if (state.detail) state.clOpen[state.detail.id] = $('checklist').open; });
$('back').addEventListener('click', () => { location.hash = '#/'; });
$('metrics-back').addEventListener('click', () => { location.hash = '#/'; });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.metricsOn && state.mdata) { state.mdrawn = ''; drawMetrics(); } }, 120); });
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
  await Promise.all([refreshList(), refreshProfile(), refreshPins()]);
  if (state.openId) await loadThread(state.openId, { quiet: true });
  if (state.metricsOn) await loadMetrics();
}
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);
drawMe();
refreshPins();
Promise.all([refreshProfile(), refreshAreas()]).then(refreshList).then(route);
