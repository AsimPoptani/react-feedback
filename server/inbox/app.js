// Feedback inbox. No build, no deps. All text goes through textContent; nothing is injected as HTML.
import { DEFAULT_AREAS, areaLabel, areaOf, sortAreas, subHeading } from './areas.js';
import { activeQuote, isReplySwipe, QUOTE_MAX, resolveQuote, shortSource, shownText, snippetOf, sourceLabel, withQuote } from './quote.js';
import { donutLabel, donutNode } from './donut.js';
import { asideGroups, isAside, parseBtw } from './aside.js';
import { ageOf, filterRows, stateOf } from './tracker.js';
import { firstPlainLine, inline, markdown, plainText } from './markdown.js';
import { secretStatusLine, secretUrl } from './secret.js';
import { createOutbox, newCid } from './outbox.js';
import { UploadError, cancelRemote, uploadFile } from './uploader.js';
import { presenceLines } from './presence.js';
import { DISMISS_KEY, offeredVersion, updateBannerText } from './version.js';
import { durationText, heatPositions, newSessionId, replaySummary } from './replays.js';
export { inline, markdown };
const API = new URL('../api/', location.href).pathname;
const PROJECT_KEY = 'fb-inbox-project';
const POLL_MS = 10000;
const MAX_IMAGES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_FILES = 10;
const FILE_OFFLINE_MAX = 50 * 1024 * 1024; // a bigger file needs a connection: it is not kept in the offline queue
const SHOWN_IMAGES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const $ = id => document.getElementById(id);
// The version baked into this page (the shell that loaded). The server's live version arrives later, on api/config.
function readLoaded() {
  const meta = document.querySelector('meta[name="rf-version"]')?.getAttribute('content')?.trim() || '';
  if (/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,40}$/.test(meta)) return meta;
  const m = /v([0-9A-Za-z][0-9A-Za-z.+_-]{0,40})/.exec($('app-version')?.textContent || '');
  return m ? m[1] : '';
}
const LOADED = readLoaded();
function paintVersion() { const node = $('app-version'); if (node && LOADED) node.textContent = `react-feedback v${LOADED}`; }

const FOLD_KEY = 'fb-inbox-folds';
const CL_KEY = 'fb-inbox-checklist';
const SIDE_KEY = 'fb-inbox-sidebar';
const state = { carryDraft: null, trackerOn: false, tdata: null, tdrawn: '', tfilter: { thread: '', state: '', q: '' }, tDoneOpen: true, focusItem: null, metricsOn: false, mwindow: '7d', mdata: null, mdrawn: '', threads: [], filter: 'all', pins: { threads: [], areas: [] }, areaConfig: DEFAULT_AREAS, expanded: new Set(), clPref: loadClPref(), sheet: false, clOwner: 'agent', clEdit: null, clShown: '', msgStop: null,
  view: null, q: '', replyTo: null, quote: null, asideOpen: new Map(), openId: null, detail: null, shown: '', images: [], newImages: [], files: [], newFiles: [], busy: false,
  config: null, serverVersion: '', dismissedUpdate: null, offline: false, secrets: new Map(), replacing: new Set(), echo: new Map(), atBottom: true, redactFor: null,
  profile: { user: { name: 'You' }, agent: { name: 'Agent' } }, order: [], gallery: [], galleryAt: 0, qsel: {}, qopen: new Set(), keptShown: new Set(), folds: loadFolds(),
  artTab: 'page', heat: false, replays: [], mysessions: null, recordInbox: false, recorder: null, projects: [], project: '', defaultProject: '', artifactOn: false, artifactsOn: false, artifactId: null, artifactVer: null, artifact: null, waitingOpen: false, shareFor: null, manageFor: null };
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function loadFolds() { try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function loadClPref() { try { const v = JSON.parse(localStorage.getItem(CL_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function saveClPref() { try { localStorage.setItem(CL_KEY, JSON.stringify(state.clPref)); } catch { /* storage may be blocked */ } }
function saveFolds() { try { localStorage.setItem(FOLD_KEY, JSON.stringify(state.folds)); } catch { /* storage may be blocked */ } }

// A request that got no answer at all is a NetworkError (`network: true`): the inbox goes offline-aware instead of showing a failure.
function projectQuery() {
  if (!state.project || !state.defaultProject || state.project === state.defaultProject) return '';
  return `project=${encodeURIComponent(state.project)}`;
}
function withProject(path) {
  if (path === 'projects' || path.startsWith('projects?')) return path;
  const q = projectQuery();
  if (!q) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${q}`;
}
async function api(path, options) {
  let response;
  try { response = await fetch(API + withProject(path), options); }
  catch { setOffline(true); const e = new Error("You're offline, or the server can't be reached."); e.network = true; throw e; }
  setOffline(!!response.headers?.get?.('X-Fb-Offline')); // the service worker marks a saved copy it served in place of the network
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail || ''; } catch { /* not JSON */ }
    const error = new Error(detail || (response.status === 413 ? 'That is too large to send.' : `Request failed (${response.status})`));
    error.status = response.status;
    throw error;
  }
  return response.json();
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fileUrl = (id, name) => `${API}items/${id}/${name}${projectQuery() ? `?${projectQuery()}` : ''}`;
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
  ['C', 'Add a checklist item for the agent'], ['Y', 'Add a checklist item for you'], ['L', 'Show or hide the checklist'], ['[', 'Collapse or expand the sidebar'], ['↑ / ↓', 'Move between messages when one is focused'], ['R', 'Reply to the focused message; Esc in the composer cancels the quote'], ['Q', 'With text selected in a message, quote it (add a note, then Enter)'], ['B', 'Ask a side question (or start a message with /btw)'],
  ['1–9, Enter', 'Pick an option on the latest open question, then answer'], ['← / →', 'Flip images in the viewer'], ['?', 'This cheat sheet'], ['Esc', 'Close the viewer or a dialog']];

// ---- Profile and avatars
// ---- Offline: messages written with no signal wait in an outbox and go out in order, each once (the server dedupes by client id).
async function postQueued(e) {
  try {
    const attachments = [];
    for (const f of e.files || []) { // a file that waited in the queue goes up first (resuming a half-finished upload), then the message names it
      if (!f.id) {
        const r = await uploadFile({ file: queuedFile(f), route: routeOf, uploadId: f.uploadId || null,
          onId: id => { if (f.uploadId !== id) { f.uploadId = id; outbox.touch(e, true); } }, onProgress: sent => { e.progress = f.size ? Math.min(99, Math.floor((sent / f.size) * 100)) : 0; outbox.touch(e); } });
        f.id = r.id; delete f.uploadId; outbox.touch(e, true);
      }
      attachments.push(f.id);
    }
    const r = await fetch(`${API}threads/${e.thread}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: e.text, images: e.images, ...(attachments.length ? { attachments } : {}), ...(e.aside ? { aside: true } : e.reply_to ? { reply_to: e.reply_to } : e.quote ? { quote: e.quote } : {}), client_id: e.cid, written_at: e.written_at }) });
    if (r.status === 404 && attachments.length) { for (const f of e.files) { delete f.id; delete f.uploadId; } outbox.touch(e, true); return { status: 503 }; } // the server dropped a file we had sent (a day old): send it again
    if (r.ok || r.status < 500) setOffline(false);
    let body = {}; try { body = await r.json(); } catch { /* no body */ }
    return { status: r.status, reason: r.ok ? undefined : body.detail, forwarded_to: typeof body.forwarded_to === 'string' ? body.forwarded_to : undefined };
  } catch (error) {
    if (error instanceof UploadError && !error.network) return { status: error.status || 400, reason: error.message };
    setOffline(true); return { network: true };
  }
}
// A file read back from the offline queue is a Blob; the uploader wants a name and a size too.
const queuedFile = f => ({ name: f.name, size: f.size, slice: (a, b) => f.blob.slice(a, b) });
const outbox = createOutbox({ post: postQueued, canSend: () => !isOffline(),
  onChange: () => { drawOffline(); if (state.detail) drawMessages(state.detail); },
  onSent: (e, result) => { state.echo.set(e.cid, e); const id = result?.forwarded_to || e.thread; if (result?.forwarded_to) { showToast('Sent in the merged thread'); if (e.thread === state.openId) location.hash = `#/${result.forwarded_to}`; } Promise.all([id === state.openId ? loadThread(id, { quiet: true }) : null, refreshList()]).finally(() => { state.echo.delete(e.cid); if (state.detail) drawMessages(state.detail); }); } });
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
  menu.replaceChildren(...items.map(it => (it.note ? el('p', { class: it.foot ? 'note ver' : 'note', text: it.note }) : el('button', { type: 'button', role: 'menuitem', ...(it.disabled ? { disabled: '' } : {}), onclick: () => { closeMenu(false); it.onclick(); } }, it.label))));
  menu.hidden = false; menuAnchor = anchor; menuUp = up; anchor.setAttribute('aria-expanded', 'true');
  placeMenu();
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
// An agent with its own name (an MCP client) gets a colour made from the name, so two agents are never mistaken for each other.
const hueOf = name => { let h = 0; for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
// A viewer (someone with a share link) has no profile: a plain "Viewer" with a V.
const personOf = who => (who === 'viewer' ? { name: 'Viewer' } : state.profile[who]);
function avatar(who, big = false, name = '') {
  if (who === 'viewer') return el('span', { class: 'avatar viewer', 'aria-hidden': 'true', text: 'V' });
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
  $('profile-name').value = state.profile.user.name; paintAvatarPreview();
  if ($('profile-record')) $('profile-record').checked = state.recordInbox;
  $('profile-dialog').showModal(); $('profile-name').select();
}
async function saveProfile(event) {
  event.preventDefault(); showError($('profile-error'), '');
  try {
    const body = { name: $('profile-name').value };
    if (profile.pending !== undefined) body.avatar = profile.pending;
    state.profile = await post('profile', body); drawMe(); state.shown = ''; if (state.detail) drawThread();
    const record = !!$('profile-record')?.checked;
    if (record !== state.recordInbox) { await post('replay-settings', { record_inbox: record }); state.recordInbox = record; if (record) void startRecording(); else stopRecording(); }
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
function pastedFiles(event) {
  return [...(event.clipboardData?.items ?? [])].filter(i => i.kind === 'file' && !TYPES.includes(i.type)).map(i => i.getAsFile()).filter(Boolean);
}

// ---- Files of any type. Each one is a chip with a progress bar; it goes up in chunks as soon as it is attached (or when the message is sent, if it could not before).
const humanSize = n => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const routeOf = path => API + withProject(path);
const attachUrl = (thread, id, inline = false) => API + withProject(`threads/${thread}/attachments/${id}${inline ? '?inline=1' : ''}`);
const isShownImage = type => SHOWN_IMAGES.includes(type);
const percentOf = e => (e.size ? Math.min(100, Math.floor((e.sent / e.size) * 100)) : 100);
function makeEntry(file) { return { key: newCid(), file, name: file.name || 'file', size: file.size, type: file.type, status: 'idle', sent: 0, id: null, uploadId: null, error: '', controller: null, promise: null }; }
function addFiles(list, files, errorEl, redraw) {
  showError(errorEl, '');
  for (const file of files) {
    if (list.length >= MAX_FILES) { showError(errorEl, `At most ${MAX_FILES} files per message.`); break; }
    const e = makeEntry(file); list.push(e);
    if (isOffline()) {
      if (file.size > FILE_OFFLINE_MAX) { e.status = 'error'; e.error = `Needs a connection: a file over ${humanSize(FILE_OFFLINE_MAX)} cannot wait offline. Remove it, or retry when you are online.`; } else e.status = 'local';
    } else void beginUpload(e, redraw);
  }
  redraw();
}
function beginUpload(e, redraw) {
  if (e.promise) return e.promise;
  e.status = 'uploading'; e.error = ''; e.controller = new AbortController();
  e.promise = (async () => {
    try {
      const r = await uploadFile({ file: e.file, route: routeOf, signal: e.controller.signal, uploadId: e.uploadId, onId: id => { e.uploadId = id; }, onProgress: sent => { e.sent = sent; paintProgress(e); } });
      e.id = r.id; e.status = 'done'; e.sent = e.size;
    } catch (error) {
      if (error.cancelled) { e.status = 'idle'; return; }
      if (error.network) { setOffline(true); e.status = e.size <= FILE_OFFLINE_MAX ? 'local' : 'error'; e.error = e.size <= FILE_OFFLINE_MAX ? '' : `Needs a connection: a file over ${humanSize(FILE_OFFLINE_MAX)} cannot wait offline. Retry when you are online.`; }
      else { e.status = 'error'; e.error = error.message || 'The upload failed.'; }
    } finally { e.controller = null; e.promise = null; redraw(); }
  })();
  redraw();
  return e.promise;
}
// Makes sure every file is on the server. Resolves { ok: true } when they all are; otherwise says why in `reason`.
async function ensureUploaded(list, redraw) {
  await Promise.all(list.filter(e => e.status !== 'done').map(e => beginUpload(e, redraw)));
  const bad = list.find(e => e.status === 'error');
  if (bad) return { ok: false, reason: `${bad.name}: ${bad.error}` };
  if (list.some(e => e.status !== 'done')) return { ok: false, network: true, reason: "You're offline. The message will wait with its files." };
  return { ok: true };
}
function removeEntry(list, e, redraw) {
  e.controller?.abort();
  if (e.uploadId) void cancelRemote(routeOf, e.uploadId);
  const at = list.indexOf(e); if (at >= 0) list.splice(at, 1);
  redraw();
}
const dropAll = list => { for (const e of list.splice(0)) { e.controller?.abort(); if (e.uploadId) void cancelRemote(routeOf, e.uploadId); } };
function paintProgress(e) {
  const node = document.querySelector(`[data-fkey="${e.key}"]`); if (!node) return;
  const bar = node.querySelector('.fbar span'), meta = node.querySelector('.fmeta'), pct = percentOf(e);
  if (bar) { bar.style.width = `${pct}%`; bar.parentNode.setAttribute('aria-valuenow', String(pct)); }
  if (meta) meta.textContent = `${humanSize(e.sent)} of ${humanSize(e.size)} · ${pct}%`;
}
function chipNode(list, e, redraw) {
  const pct = percentOf(e);
  const meta = e.status === 'uploading' ? `${humanSize(e.sent)} of ${humanSize(e.size)} · ${pct}%` : e.status === 'done' ? `${humanSize(e.size)} · ready to send`
    : e.status === 'local' ? `${humanSize(e.size)} · uploads with the message when you are online` : e.status === 'error' ? e.error : humanSize(e.size);
  const buttons = e.status === 'uploading' ? [el('button', { type: 'button', 'aria-label': `Cancel the upload of ${e.name}`, onclick: () => removeEntry(list, e, redraw) }, 'Cancel')]
    : [...(e.status === 'error' ? [el('button', { type: 'button', 'aria-label': `Retry ${e.name}`, onclick: () => { if (isOffline() && e.size > FILE_OFFLINE_MAX) { e.error = 'Still offline: this file needs a connection.'; redraw(); } else void beginUpload(e, redraw); } }, 'Retry')] : []),
      el('button', { type: 'button', 'aria-label': `Remove ${e.name}`, onclick: () => removeEntry(list, e, redraw) }, 'Remove')];
  return el('div', { class: 'fchip', 'data-fkey': e.key, 'data-state': e.status, role: 'group', 'aria-label': `File ${e.name}` },
    el('span', { class: 'fname', title: e.name, text: e.name }), el('span', { class: 'fmeta', ...(e.status === 'error' ? { role: 'alert' } : {}), text: meta }), el('div', { class: 'fbtns' }, ...buttons),
    ...(e.status === 'uploading' || e.status === 'done' ? [el('div', { class: 'fbar', role: 'progressbar', 'aria-label': `Upload of ${e.name}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(e.status === 'done' ? 100 : pct) }, el('span', { style: `width:${e.status === 'done' ? 100 : pct}%` }))] : []));
}
function drawChips(host, list, redraw) { host.replaceChildren(...list.map(e => chipNode(list, e, redraw))); }
// A file already in a thread: an image shows as a picture; a PDF can be previewed in a sandboxed frame; everything else is a name, a size and Download.
function fileCard(d, a) {
  const pdf = a.type === 'application/pdf';
  const card = el('div', { class: `file-card${pdf ? ' pdf' : ''}`, 'data-attachment': a.id }, el('span', { class: 'fname', title: a.name, text: a.name }), el('span', { class: 'fmeta', text: humanSize(a.size) }));
  if (pdf) {
    const button = el('button', { type: 'button', 'aria-expanded': 'false', 'aria-label': `Preview ${a.name}` }, 'Preview');
    button.addEventListener('click', () => {
      const frame = card.querySelector('iframe');
      if (frame) { frame.remove(); card.querySelector('.nopreview')?.remove(); button.textContent = 'Preview'; button.setAttribute('aria-expanded', 'false'); return; }
      const created = el('iframe', { title: `Preview of ${a.name}`, src: attachUrl(d.id, a.id, true), loading: 'lazy', referrerpolicy: 'no-referrer' });
      created.setAttribute('sandbox', ''); // nothing allowed: no scripts, no same-origin access
      card.append(created, el('p', { class: 'nopreview', text: 'If the preview stays blank, this browser cannot show a PDF here: use Download.' }));
      button.textContent = 'Hide preview'; button.setAttribute('aria-expanded', 'true');
    });
    card.append(button);
  }
  card.append(el('a', { class: 'fdl', href: attachUrl(d.id, a.id), download: a.name, rel: 'noopener', 'aria-label': `Download ${a.name}` }, 'Download'));
  return card;
}
function appendFiles(node, d, m, who) {
  const list = m.attachments || [];
  const pictures = list.filter(a => isShownImage(a.type)), rest = list.filter(a => !isShownImage(a.type));
  if (pictures.length) node.append(el('div', { class: 'imgs' }, ...pictures.map(a => imageButton(a.id, `${a.name} from ${who.name}`, attachUrl(d.id, a.id)))));
  if (rest.length) node.append(el('div', { class: 'files' }, ...rest.map(a => fileCard(d, a))));
}
// Drag a file onto the thread or the new-thread box: a small picture is attached as an image, anything else as a file.
function takeDropped(files, target) {
  const images = [], others = [];
  for (const f of files) (TYPES.includes(f.type) && f.size <= MAX_BYTES ? images : others).push(f);
  if (target === 'new') { if (images.length) addImages(state.newImages, images, $('new-error'), redrawNew); if (others.length) addFiles(state.newFiles, others, $('new-error'), redrawNew); }
  else { if (images.length) addImages(state.images, images, $('error'), redrawComposer); if (others.length) addFiles(state.files, others, $('error'), redrawComposer); }
}
function dragHooks(zone, target, allowed = () => true) {
  const has = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  zone.addEventListener('dragenter', e => { if (has(e) && allowed()) { e.preventDefault(); depth++; zone.classList.add('dropping'); } });
  zone.addEventListener('dragover', e => { if (has(e) && allowed()) e.preventDefault(); });
  zone.addEventListener('dragleave', e => { if (has(e) && --depth <= 0) { depth = 0; zone.classList.remove('dropping'); } });
  zone.addEventListener('drop', e => { if (!has(e)) return; e.preventDefault(); depth = 0; zone.classList.remove('dropping'); if (allowed()) takeDropped([...e.dataTransfer.files], target); });
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
  d.messages.forEach(m => (m.attachments || []).filter(a => isShownImage(a.type)).forEach(a => g.push({ key: a.id, src: attachUrl(d.id, a.id), caption: `${a.name} (${humanSize(a.size)})` })));
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
  const unreadN = state.threads.filter(t => t.unread_for_user).length;
  $('rail-unread').hidden = !unreadN; $('rail-unread').textContent = String(unreadN); $('rail-unread').setAttribute('aria-label', `${unreadN} unread`);
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
// Where the captured element was written, when the page knew: a small "src/…/Thing.tsx:42" chip (click copies file:line:column). Absent in production builds.
function sourceChip(target) {
  const s = target && typeof target === 'object' ? target.source : null;
  if (!s || typeof s.file !== 'string' || !s.file) return null;
  const full = sourceLabel(s);
  const note = [s.component ? `in ${s.component}` : '', s.ancestor ? 'the nearest ancestor with source info' : '', s.runtime ? 'runtime position, not source-mapped' : ''].filter(Boolean).join(' · ');
  const chip = el('button', { type: 'button', class: 'src-chip', title: `${full}${note ? ` · ${note}` : ''} · click to copy`, 'aria-label': `Source: ${full}${note ? `, ${note}` : ''}. Copy it.`, onclick: () => { try { void navigator.clipboard?.writeText(full); showToast('Copied the source location'); } catch { /* no clipboard */ } } },
    el('code', { text: shortSource(s) }));
  const names = Array.isArray(target.components) ? target.components.filter(n => typeof n === 'string').slice(0, 4) : [];
  return el('p', { class: 'info src-row' }, el('span', { class: 'hint', text: 'Source ' }), chip, ...(s.runtime ? [el('span', { class: 'hint', text: ' runtime, not source-mapped' })] : []), ...(names.length ? [el('span', { class: 'hint', text: ` · ${names.join(' < ')}` })] : []));
}
function drawCapture(d) {
  const box = $('capture');
  if (!d.files.image) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const extras = el('div', { class: 'extra', id: 'extras', hidden: '' });
  if (d.files.annotated) extras.append(el('figure', {}, imageFig('annotated.png', fileUrl(d.id, 'annotated.png'), 'Annotated capture'), el('figcaption', { text: 'Annotated' })));
  if (d.files.context) extras.append(el('figure', {}, imageFig('context.png', fileUrl(d.id, 'context.png'), 'Context: the viewport with the target outlined'), el('figcaption', { text: 'Context' })));
  const kids = [imageButtonBlock('image.png', fileUrl(d.id, 'image.png'), `Captured ${d.mode}`), el('p', { class: 'info', text: describeTarget(d) })];
  const source = sourceChip(d.target);
  if (source) kids.push(source);
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
// A typed or kept answer is remembered per thread (question ids repeat from thread to thread).
const qk = qid => `${state.openId}:${qid}`;
function activeQuestion() {
  const d = state.detail; if (!d || d.merged_into || d.read_only) return null;
  const open = d.messages.filter(m => m.question && !m.question.withdrawn && !m.question.reasked && !m.question.expired && !answerFor(d, m.question)).map(m => m.question);
  return open[open.length - 1] || null;
}
const flatPrompt = text => String(text || '').replace(/\s+/g, ' ').trim();
function laterCopy(d, m) {
  return d.messages.slice(d.messages.indexOf(m) + 1).find(item => item.question && item.question.prompt === m.question.prompt && !item.question.withdrawn && !item.question.reasked) || null;
}
function keptText(s, q) {
  const labels = s.ids.map(id => q.options.find(o => o.id === id)?.label).filter(Boolean);
  const other = s.other.trim();
  return [...labels, ...(other ? [other] : [])].join(', ');
}
// Read every Other box before a redraw. The pinned bar does not write state until Enter, so a withdraw would otherwise drop the text.
function harvestDrafts() {
  const found = new Map();
  for (const input of document.querySelectorAll('.qother')) {
    const qid = input.closest('[data-question]')?.getAttribute('data-question') || (input.closest('#waiting-bar') ? $('waiting-bar')?.dataset.question : '');
    if (!qid) continue;
    const focused = document.activeElement === input;
    const prev = found.get(qid);
    if (!prev || focused || (!prev.focused && input.value.length >= prev.value.length)) found.set(qid, { value: input.value, focused });
  }
  for (const [qid, draft] of found) {
    const prev = state.qsel[qk(qid)] ?? { ids: [], other: '' };
    if (!prev.ids.length && !draft.value.trim()) delete state.qsel[qk(qid)];
    else state.qsel[qk(qid)] = { ids: prev.ids, other: draft.value };
  }
}
function revealKept(d) {
  if (!d) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const m of d.messages || []) {
    const q = m.question;
    if (!q || (!q.withdrawn && !q.reasked && !q.expired)) continue;
    const s = state.qsel[qk(q.id)];
    if (!s || (!s.ids.length && !s.other.trim())) continue;
    const key = `${d.id}:${q.id}`;
    if (state.keptShown.has(key)) continue;
    state.keptShown.add(key);
    document.querySelector(`#msgs [data-question="${q.id}"]`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }
}
async function sendKept(d, m) {
  const q = m.question, s = state.qsel[qk(q.id)];
  const text = s ? keptText(s, q) : '';
  if (!d || !text || state.busy) return;
  state.busy = true;
  try {
    await post(`threads/${d.id}/messages`, { text, reply_to: m.id });
    delete state.qsel[qk(q.id)];
    state.shown = '';
    await Promise.all([loadThread(d.id), refreshList()]);
  } catch (error) { showError($('error'), error.message); }
  finally { state.busy = false; }
}
async function useOnCopy(d, m, copy) {
  const q = m.question, nq = copy?.question, s = state.qsel[qk(q.id)];
  if (!d || !nq || !s || state.busy) return;
  const option_ids = s.ids.map(id => { const label = q.options.find(o => o.id === id)?.label; return nq.options.find(o => o.label === label)?.id; }).filter(Boolean);
  const other = s.other.trim();
  if (!option_ids.length && !other) return;
  state.busy = true;
  try {
    await post(`threads/${d.id}/answer`, { question_id: nq.id, option_ids, ...(other ? { other_text: other } : {}) });
    delete state.qsel[qk(q.id)];
    state.shown = '';
    await Promise.all([loadThread(d.id), refreshList()]);
  } catch (error) { showError($('error'), error.message); }
  finally { state.busy = false; }
}
function rescueFor(d, m, copy) {
  const q = m.question, s = state.qsel[qk(q.id)];
  if (!s || (!s.ids.length && !s.other.trim()) || (!q.withdrawn && !q.reasked && !q.expired)) return null;
  const box = el('div', { class: 'qrescue' });
  const labels = s.ids.map(id => q.options.find(o => o.id === id)?.label).filter(Boolean);
  if (labels.length) box.append(el('span', { class: 'hint', text: labels.join(', ') }));
  if (s.other.trim()) {
    const other = el('input', { type: 'text', class: 'qother', maxlength: '1000', 'aria-label': 'Kept answer' });
    other.value = s.other;
    other.addEventListener('input', () => { s.other = other.value; });
    other.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (q.reasked && copy) void useOnCopy(d, m, copy); else void sendKept(d, m);
    });
    box.append(other);
  }
  box.append(el('button', { type: 'button', onclick: () => { void sendKept(d, m); } }, 'Send as a message'));
  if (q.reasked && copy) box.append(el('button', { type: 'button', onclick: () => { void useOnCopy(d, m, copy); } }, 'Use on the new copy'));
  return box;
}
function closedQuestion(d, m) {
  const q = m.question, open = state.qopen.has(q.id), copy = q.reasked ? laterCopy(d, m) : null, flat = flatPrompt(q.prompt);
  const show = el('button', { type: 'button', class: 'show', text: open ? 'hide' : 'show', onclick: () => { if (open) state.qopen.delete(q.id); else state.qopen.add(q.id); drawMessages(d); } });
  const line = el('div', { class: 'qclosed' });
  if (q.reasked) line.append(el('button', { type: 'button', class: 'qlink', text: 'Re-asked below', onclick: () => { if (copy) jumpToQuestion(copy.question.id); } }), el('span', { class: 'qsum', text: ` · ${flat}` }), show);
  else if (q.withdrawn) line.append(el('span', { class: 'qsum', text: `Withdrawn · ${flat}${q.withdrawn?.reason ? ` · ${q.withdrawn.reason}` : ''}` }), show);
  else line.append(el('span', { class: 'qsum', ...(q.expires_at ? { title: `Expired ${when(q.expires_at)}` } : {}), text: `Expired · ${flat}` }), show);
  const kind = q.withdrawn ? 'withdrawn' : q.reasked ? 'reasked' : 'expired';
  const card = el('div', { class: `qcard ${kind}`, 'data-question': q.id, role: 'group', 'aria-label': kind === 'withdrawn' ? 'Withdrawn question' : kind === 'reasked' ? 'Re-asked question' : 'Expired question' }, line);
  if (open) {
    card.append(el('p', { class: 'prompt struck', text: q.prompt }));
    const opts = el('div', { class: 'qopts' });
    for (const o of q.options) {
      const b = el('button', { type: 'button', class: 'qopt', 'data-opt': o.id, 'aria-pressed': 'false' }, el('span', { text: o.label }));
      b.disabled = true;
      opts.append(b);
    }
    card.append(opts);
    if (copy) card.append(el('button', { type: 'button', class: 'qlink', text: 'Re-asked below', onclick: () => jumpToQuestion(copy.question.id) }));
  }
  const rescue = rescueFor(d, m, copy);
  if (rescue) card.append(rescue);
  return card;
}
const selFor = q => (state.qsel[qk(q.id)] ??= { ids: [], other: '' });
function toggleOption(q, optId) {
  const s = selFor(q);
  if (q.multi) s.ids = s.ids.includes(optId) ? s.ids.filter(i => i !== optId) : [...s.ids, optId]; else s.ids = [optId];
  paintCard(q);
}
function paintCard(q) {
  const cards = document.querySelectorAll(`[data-question="${q.id}"]`); if (!cards.length) return;
  const s = selFor(q);
  for (const card of cards) {
    for (const b of card.querySelectorAll('.qopt')) b.setAttribute('aria-pressed', String(s.ids.includes(b.dataset.opt)));
    const submit = card.querySelector('.qsubmit'); if (submit) submit.disabled = !s.ids.length && !s.other.trim();
  }
}
async function submitAnswer(q) {
  const d = state.detail, s = selFor(q);
  if (!d || d.merged_into || state.busy || (!s.ids.length && !s.other.trim())) return;
  state.busy = true;
  try {
    const sent = await post(`threads/${d.id}/answer`, { question_id: q.id, option_ids: s.ids, ...(s.other.trim() ? { other_text: s.other.trim() } : {}) });
    delete state.qsel[qk(q.id)];
    if (sent?.forwarded_to) { showToast('Sent in the merged thread'); location.hash = `#/${sent.forwarded_to}`; return; }
    await Promise.all([loadThread(d.id), refreshList()]);
  } catch (error) {
    if (error.status === 409 && /withdrawn|re-asked|expired/.test(error.message || '')) { showError($('error'), ''); await loadThread(d.id, { quiet: true }); }
    else {
      showError($('error'), error.message);
      await loadThread(d.id, { quiet: true });
      const now = state.detail;
      const into = now?.id === d.id ? now.merged_into || error.forwarded_to : '';
      if (/already answered/.test(error.message) && into) {
        if (s.other.trim()) state.carryDraft = { from: d.id, into, text: state.carryDraft?.from === d.id ? state.carryDraft.text : '', other: s.other, prompt: q.prompt };
        const title = state.threads.find(t => t.id === into)?.title || into;
        const box = $('error');
        box.replaceChildren(document.createTextNode('This thread was merged into '), el('strong', { text: title }), document.createTextNode(' · '), el('a', { href: `#/${into}`, text: 'Open' }));
        box.hidden = false;
      }
    }
  }
  finally { state.busy = false; }
}
function questionCard(d, m) {
  const q = m.question;
  if (q.withdrawn || q.reasked || q.expired) return closedQuestion(d, m);
  const ans = answerFor(d, q), s = selFor(q);
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
  if (d.merged_into) for (const control of card.querySelectorAll('button, input, textarea')) control.disabled = true;
  queueMicrotask(() => { if (!d.merged_into) paintCard(q); });
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
function jumpToQuestion(qid) {
  const card = document.querySelector(`#scroll [data-question="${qid}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
}
function messageNode(d, m) {
  if (m.divider && m.moved_to) return el('div', { class: 'divider', role: 'separator', 'data-mid': m.id }, el('span', {}, 'Moved to ', el('a', { href: `#/${m.moved_to}`, text: (/^Moved to \[(.*)\]\(#\//.exec(m.text) || [])[1] || 'another thread' })));
  if (m.divider && m.kind === 'share_notice') return el('div', { class: 'divider share-notice', role: 'status' }, el('span', { text: m.text.replace(/ · Revoke$/, '') }), ...(m.share_id ? [el('button', { type: 'button', onclick: () => { void revokeShare(m.share_id); } }, 'Revoke')] : []));
  if (m.divider) return el('div', { class: 'divider', role: 'separator' }, el('span', { text: m.text }));
  const who = m.kind === 'viewer_feedback' ? { name: m.label ? `Viewer feedback · ${m.label}` : 'Viewer feedback' } : m.agent_name ? { ...state.profile.agent, name: m.agent_name } : personOf(m.author);
  const farewell = d.merged_into && m === d.messages[d.messages.length - 1]; // the link to the merged thread stays visible
  const folded = quiet(d, m) && !farewell && !state.expanded.has(expandKey(d, m));
  const badge = m.author === 'agent' || m.author === 'viewer' ? flagBadge(m.flag) : null;
  if (folded) {
    const first = (m.redacted ? '🔒 Redacted' : firstPlainLine(m.text) || (m.images.length ? '[image]' : m.attachments?.length ? '[file]' : '')).slice(0, 160);
    return el('article', { class: 'msg agent collapsed', 'data-mid': m.id, 'aria-label': `${who.name}, ${when(m.created_at)}, ${FLAG[m.flag][0]}` },
      avatar(m.author, false, m.agent_name), ...(badge ? [badge] : []), el('span', { class: 'peek', text: first }), el('time', { datetime: m.created_at, text: when(m.created_at) }),
      el('button', { type: 'button', class: 'show', onclick: () => toggleExpanded(d, m) }, 'Show'));
  }
  const head = el('div', { class: 'who' }, avatar(m.author, false, m.agent_name), el('strong', { text: who.name }), ' · ', el('time', { datetime: m.written_at || m.created_at, text: when(m.written_at || m.created_at), ...sentTitle(m) }), ...(badge ? [badge] : []));
  if (quiet(d, m) && !farewell) head.append(el('button', { type: 'button', class: 'show', onclick: () => toggleExpanded(d, m) }, 'Hide'));
  if (m.author === 'user' && d.acked_through === m.created_at) head.append(el('span', { class: 'acked-note', text: `· ${state.profile.agent.name} acknowledged` }));
  const ticks = ticksFor(d, m); if (ticks) head.append(ticks);
  if (!d.read_only && !d.merged_into) head.append(el('button', { type: 'button', class: 'reply-btn', 'aria-label': `Reply to ${who.name}, ${when(m.created_at)}`, onclick: () => startReply(m.id) }, 'Reply'));
  if (m.author === 'user' && !m.redacted && state.config?.redact) head.append(el('button', { type: 'button', class: 'msg-more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `More actions for your message of ${when(m.created_at)}`, onclick: e => openMenu(e.currentTarget, [{ label: 'Redact…', onclick: () => askRedact(d, m) }]) }, '⋯'));
  const node = el('article', { class: `msg ${m.author}${m.flag === 'needs_you' ? ' needs' : ''}`, 'data-mid': m.id, tabindex: '-1', 'aria-label': `${who.name}, ${when(m.created_at)}` }, head);
  const quoted = quoteNode(d, m); if (quoted) node.append(quoted);
  const picked = m.quote?.message_id ? selectionQuoteNode(d, m.quote) : null; if (picked) node.append(picked);
  if (m.redacted) { node.classList.add('redacted'); node.append(el('p', { class: 'locked', ...(m.redacted.reason ? { title: m.redacted.reason } : {}), text: lockedText(m) })); return node; }
  if (m.answer) {
    const asked = (d.messages || []).find(item => item.question?.id === m.answer.question_id)?.question;
    node.append(el('button', { type: 'button', class: 'qchip', onclick: () => jumpToQuestion(m.answer.question_id) }, `↩ ${m.answer.question_id} · ${clip(asked?.prompt || 'Question', 42)}`));
  }
  if (m.kind === 'viewer_feedback' && m.quote) node.append(el('blockquote', { class: 'viewer-quote' }, el('span', { class: 'hint', text: 'Pointing at' }), ...(m.quote.text ? [el('span', { text: ` \u201c${m.quote.text}\u201d` })] : []), ...(m.quote.path ? [el('code', { text: m.quote.path })] : [])));
  if (m.question) node.append(questionCard(d, m)); else if (shownText(m)) node.append(markdown(shownText(m)));
  if (m.kind === 'secret_request' && m.secret) node.append(secretNode(d, m));
  if (m.images.length) node.append(el('div', { class: 'imgs' }, ...m.images.map((f, i) => imageButton(f, `Image ${i + 1} from ${who.name}`, fileUrl(d.id, f)))));
  appendFiles(node, d, m, who);
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
    s = { box: el('div', { class: 'secret', 'data-secret': m.secret.name, 'data-rf-private': '' }), input, error: '', busy: false };
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
  appendFiles(node, d, m, who);
  const attached = attachedNode(d, m); if (attached) node.append(attached);
  return node;
}
function asideNode(d, g) {
  const open = asideIsOpen(d, g), agent = state.profile.agent.name;
  const first = (g.root.redacted ? '🔒 Redacted' : firstPlainLine(g.root.text) || (g.root.images.length ? '[image]' : g.root.attachments?.length ? '[file]' : '')).slice(0, 120);
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
function threadNodes(d) {
  const groups = asideGroups(d.messages, d.acked_through || null);
  const grouped = new Set(groups.flatMap(g => [g.root.id, ...g.answers.map(a => a.id)]));
  // A fired reminder was for the agent, so it is not drawn here: its history is in the Reminders sheet.
  return d.messages.flatMap(m => {
    const g = groups.find(x => x.root.id === m.id);
    if (g) return [asideNode(d, g)];
    if (isAside(m) && !grouped.has(m.id)) return []; // an answer whose question is gone
    return [messageNode(d, m)];
  }).concat(queuedNodes(d));
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
  const picked = e.quote ? selectionQuoteNode(d, e.quote) : null; if (picked) node.append(picked);
  if (shownText(e)) node.append(markdown(shownText(e)));
  if (e.images.length) node.append(el('div', { class: 'imgs' }, ...e.images.map((src, i) => el('span', {}, el('img', { src, alt: `Picture ${i + 1}, waiting to send` })))));
  if (e.files?.length) node.append(el('div', { class: 'files' }, ...e.files.map(f => el('div', { class: 'file-card' }, el('span', { class: 'fname', title: f.name, text: f.name }), el('span', { class: 'fmeta', text: `${humanSize(f.size)} · ${f.id ? 'uploaded' : 'waiting to upload'}` })))));
  if (sent) { node.classList.remove('queued'); return node; }
  if (failed) node.append(el('div', { class: 'qstate bad', role: 'note' }, el('span', { text: `Couldn't send: ${e.reason}` }), el('button', { type: 'button', onclick: () => outbox.retry(e.cid) }, 'Try again'), el('button', { type: 'button', onclick: () => outbox.remove(e.cid) }, 'Delete')));
  else node.append(el('div', { class: 'qstate', 'data-state': e.sending ? 'sending' : 'waiting' }, clockIcon(), el('span', { text: e.sending ? (e.progress && e.files?.some(f => !f.id) ? `Sending… files ${e.progress}%` : 'Sending…') : e.attempts ? 'Waiting to send · will retry' : 'Waiting to send' }),
    ...(e.sending ? [] : [el('button', { type: 'button', 'aria-label': 'Delete this message before it sends', onclick: () => outbox.remove(e.cid) }, 'Delete')])));
  return node;
}
function drawMessages(d) {
  const open = [...state.expanded].filter(k => k.startsWith(`${d.id}:`)).sort();
  const qopen = [...state.qopen].sort();
  const asides = [...state.asideOpen].filter(([k]) => k.startsWith(`${d.id}:`));
  const key = JSON.stringify([d.id, d.status, d.user_read_at, d.agent_read_at, d.acked_through, state.profile, open, qopen, asides, d.messages.map(m => m.id + m.created_at + (m.answer ? 'a' : '') + (m.flag || '') + (m.aside ? 's' : '') + (m.added_items || []).join() + (m.ticked_items || []).join() + (m.redacted ? 'r' : '') + (m.secret?.status || '') + (m.secret?.hint || '') + (m.question?.withdrawn ? 'w' : '') + (m.question?.reasked ? 'q' : '') + (m.question?.expired ? 'x' : '') + (m.quote?.message_id ? 'k' : '') + (m.kind || '')),
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
  const name = personOf(q.original.author).name;
  return el('button', { type: 'button', class: `quote ${q.original.author}`, 'aria-label': `In reply to ${name}: ${q.snippet || 'message'}. Go to the original.`, onclick: () => jumpTo(q.original.id) },
    el('strong', { text: name }), el('span', { class: 'snip', text: q.snippet }));
}
// A quote of selected text: a linked block (the author, then the words) that jumps to the message it came from. The message's own text has the same words as a `> ` block; that block is not drawn twice.
function selectionQuoteNode(d, quote) {
  const original = (d.messages || []).find(m => m.id === quote.message_id && !m.divider);
  const words = el('span', { class: 'snip sel', text: quote.text });
  if (!original) return el('span', { class: 'quote missing', role: 'note' }, el('span', { class: 'snip sel', text: quote.text }), el('em', { text: ' · original message unavailable' }));
  const name = personOf(original.author).name;
  return el('button', { type: 'button', class: `quote ${original.author}`, 'aria-label': `Quoting ${name}: ${quote.text.slice(0, 120)}. Go to the original.`, onclick: () => jumpTo(original.id) }, el('strong', { text: name }), words);
}
// ---- Quote a bit of a message. Select text inside one message (a mouse, the keyboard, or a long press on a phone) and a small popover offers Quote, with an optional note.
// Quote puts the words in the composer as a `> ` block, then the note; the sent message carries `quote: { message_id, text }`, drawn as a quote that jumps to the source.
const qpop = { text: '', mid: '', hold: false, timer: 0 };
const nodeElement = node => (node && node.nodeType === 1 ? node : node?.parentElement) || null;
function readSelection() {
  const d = state.detail, sel = window.getSelection?.();
  if (!d || d.read_only || d.merged_into || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const from = nodeElement(range.startContainer)?.closest?.('.msg[data-mid]'), to = nodeElement(range.endContainer)?.closest?.('.msg[data-mid]');
  if (!from || from !== to || !$('msgs').contains(from)) return null;
  const m = d.messages.find(x => x.id === from.dataset.mid);
  if (!m || m.divider || m.aside || m.redacted || m.moved_to || m.kind === 'secret_request') return null;
  if (nodeElement(range.startContainer)?.closest?.('input, textarea, .secret')) return null;
  const text = sel.toString().replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return text ? { mid: m.id, text: text.slice(0, QUOTE_MAX), rect: range.getBoundingClientRect() } : null;
}
function hideQuotePop() { const pop = $('qpop'); if (pop) pop.hidden = true; qpop.text = ''; qpop.mid = ''; qpop.hold = false; }
function showQuotePop(found) {
  const pop = $('qpop'); if (!pop) return;
  const fresh = pop.hidden || qpop.text !== found.text;
  qpop.text = found.text; qpop.mid = found.mid;
  if (fresh) { $('qpop-note').value = ''; }
  pop.hidden = false;
  const docked = window.matchMedia?.('(max-width: 760px), (pointer: coarse)').matches; // a phone: a bar at the foot of the screen, clear of the system's own selection menu
  pop.classList.toggle('dock', !!docked);
  if (docked) { pop.style.left = ''; pop.style.top = ''; return; }
  const box = pop.getBoundingClientRect(), r = found.rect;
  const below = r.bottom + 8 + box.height <= window.innerHeight;
  pop.style.top = `${Math.max(8, below ? r.bottom + 8 : r.top - box.height - 8)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8))}px`;
}
function checkSelection() {
  const pop = $('qpop'); if (!pop) return;
  if (!pop.hidden && (qpop.hold || pop.contains(document.activeElement))) return; // the person is using the popover: the selection collapsing is theirs
  const found = readSelection();
  if (found) showQuotePop(found); else hideQuotePop();
}
function scheduleSelection() { clearTimeout(qpop.timer); qpop.timer = setTimeout(checkSelection, 180); }
function takeQuote() {
  const d = state.detail; if (!d || d.read_only || !qpop.text) return;
  const box = $('text'), note = $('qpop-note').value;
  box.value = withQuote(box.value, qpop.text, note);
  state.quote = { message_id: qpop.mid, text: qpop.text };
  state.replyTo = null; drawReplyBar();
  window.getSelection?.()?.removeAllRanges();
  hideQuotePop();
  growText(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
}
// A quote counts only while its block is still at the top of what is being sent.
const quoteToSend = text => activeQuote(state.quote, text);
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
  $('replybar-text').replaceChildren(el('strong', { text: personOf(m.author).name }), snippetOf(m));
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

// A merged-away thread stays readable. The composer and the question cards cannot post here; a late post is forwarded.
function drawMerged(d) {
  const banner = $('merged-banner');
  if (!banner) return;
  const into = d?.merged_into;
  banner.hidden = !into;
  const off = !!into;
  if (into) {
    const title = state.threads.find(t => t.id === into)?.title || into;
    banner.replaceChildren(document.createTextNode('Merged into '), el('strong', { text: title }), document.createTextNode(' · '), el('a', { href: `#/${into}`, text: 'Open' }));
  }
  if (into) keepDraft(d);
  const kept = !!into && !!state.carryDraft && state.carryDraft.from === d.id && !!$('text')?.value; // typed text stays visible and selectable so it can be copied out
  $('composer')?.setAttribute('aria-disabled', String(off));
  for (const id of ['text', 'send', 'attach', 'attach-file', 'btw', 'plus']) { const node = $(id); if (node) node.disabled = off && !(kept && id === 'text'); }
  if ($('text')) $('text').readOnly = off && kept;
}
// What the person had typed (composer, or an Other box) when a thread turned merged. It is restored on the target, so a merge never loses typing.
function keepDraft(d) {
  const text = $('text')?.value || '';
  const open = (d.messages || []).filter(m => m.author === 'agent' && m.question && !m.question.withdrawn && !m.question.reasked && !m.question.expired);
  const bar = $('waiting-bar')?.querySelector('.qother')?.value || '';
  const stored = open.map(m => ({ q: m.question, other: state.qsel[qk(m.question.id)]?.other || '' })).filter(x => x.other.trim()).pop();
  const typed = bar.trim() ? { q: open[open.length - 1]?.question, other: bar } : stored;
  const prev = state.carryDraft?.from === d.id ? state.carryDraft : null;
  const draft = { from: d.id, into: d.merged_into, text: text || prev?.text || '', other: typed?.other || prev?.other || '', prompt: typed?.q?.prompt || prev?.prompt || '' };
  if (draft.text.trim() || draft.other.trim()) state.carryDraft = draft; else if (prev) state.carryDraft = null;
}
function takeDraft(into) {
  const c = state.carryDraft;
  if (!c || c.into !== into) return '';
  state.carryDraft = null;
  const quoted = c.other.trim() ? `${c.prompt ? `> ${clip(c.prompt, 200)}\n` : ''}${c.other.trim()}` : '';
  return [quoted, c.text.trim() ? c.text : ''].filter(Boolean).join('\n\n');
}
let toastTimer = 0;
function showToast(text) {
  const node = $('toast');
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
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
  drawFired(v);
  $('remind-list').replaceChildren(...(v.items.length ? v.items.map(r => el('li', {}, el('span', { class: 'what' }, el('strong', { text: kindText(r) }), el('small', { text: r.say })),
    el('button', { type: 'button', 'aria-label': `Remove the reminder: ${r.say}`, onclick: () => removeReminder(r.id) }, 'Remove'))) : [el('li', { class: 'hint', text: 'No reminders of your own on this thread.' })]));
}
function drawFired(v) {
  const list = [...(v.fired || [])].sort((a, b) => b.at.localeCompare(a.at));
  $('remind-fired').replaceChildren(...(list.length ? list.map(f => el('li', { 'data-fired': f.id }, el('span', { class: 'what' }, el('small', { text: f.text })), el('time', { datetime: f.at, text: when(f.at) }))) : [el('li', { class: 'hint', text: 'None yet.' })]));
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
  const page = state.metricsOn || state.trackerOn || state.artifactOn || state.artifactsOn;
  $('app').classList.toggle('has-thread', !!d || page);
  $('placeholder').style.display = d || page ? 'none' : '';
  $('tracker').style.display = state.trackerOn ? 'flex' : 'none';
  $('tracker-link').setAttribute('aria-current', state.trackerOn ? 'page' : 'false');
  $('open').style.display = d ? 'flex' : 'none';
  $('metrics').style.display = state.metricsOn ? 'flex' : 'none';
  $('metrics-link').setAttribute('aria-current', state.metricsOn ? 'page' : 'false');
  const art = $('artifact'), arts = $('artifacts'), artLink = $('artifacts-link');
  if (art) art.style.display = state.artifactOn ? 'flex' : 'none';
  if (!state.artifactOn) removeArtifactFrame();
  if (arts) arts.style.display = state.artifactsOn ? 'flex' : 'none';
  if (artLink) artLink.setAttribute('aria-current', state.artifactOn || state.artifactsOn ? 'page' : 'false');
  if (!d) { drawMerged(null); drawWaiting(null); return; }
  drawReadOnly(d);
  drawMerged(d);
  $('title').textContent = d.title;
  document.title = `${d.title} · Feedback inbox`;
  $('toggle-done').replaceChildren(d.status === 'done' ? 'Reopen' : 'Mark done', kbd('E'));
  if (state.captureFor !== d.id) { drawCapture(d); state.captureFor = d.id; }
  $('merge-open').hidden = !!d.merged_into || d.read_only === true;
  $('move-open').hidden = state.projects.length < 2 || !!d.merged_into;
  drawPinThread(); drawChecklist(d);
  const typing = document.activeElement;
  const typingQ = typing?.classList?.contains('qother') ? (typing.closest('[data-question]')?.getAttribute('data-question') || ($('waiting-bar')?.contains(typing) ? $('waiting-bar').dataset.question || '' : '')) : '';
  harvestDrafts();
  drawMessages(d); drawArtifactCards(d); drawWaiting(d); drawReplyBar();
  if (typingQ && !document.activeElement?.classList?.contains('qother')) document.querySelector(`#msgs [data-question="${typingQ}"] .qother`)?.focus();
  revealKept(d);
}
async function loadThread(id, { quiet = false } = {}) {
  try {
    const d = await api(`threads/${id}`);
    if (id !== state.openId) return;
    state.detail = d; drawThread(); if (state.focusItem) focusItemNow();
    const shareUnread = (d.messages || []).some(m => (m.kind === 'share_notice' || m.kind === 'viewer_feedback') && (!d.user_read_at || m.created_at > d.user_read_at));
    if ((d.last_author === 'agent' && (!d.user_read_at || d.user_read_at < d.last_message_at)) || shareUnread) { // ticks need the read marker even for FYIs; a share notice counts as unread too
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
  const artMatch = /^#\/artifact\/(a[0-9a-f]{12})(?:\/v(\d+))?$/.exec(location.hash);
  const artsPage = location.hash === '#/artifacts';
  const [, raw = null, item = null] = artMatch || artsPage ? [] : (/^#\/([\w-]+)(?:\/(c\d+))?$/.exec(location.hash) || []);
  const metrics = raw === 'metrics', tracker = raw === 'tracker', id = metrics || tracker ? null : raw;
  const artifactId = artMatch ? artMatch[1] : null;
  const artifactVer = artMatch && artMatch[2] ? Number(artMatch[2]) : null;
  state.focusItem = id && item ? item : null;
  if (id === state.openId && metrics === state.metricsOn && tracker === state.trackerOn && artsPage === state.artifactsOn && artifactId === state.artifactId && artifactVer === state.artifactVer) { if (state.focusItem && state.detail) focusItemNow(); return; }
  state.metricsOn = metrics; state.trackerOn = tracker; state.artifactsOn = artsPage; state.artifactOn = !!artMatch; state.artifactId = artifactId; state.artifactVer = artifactVer;
  harvestDrafts(); // keep what was typed in the thread being left, under its own id
  for (const stale of document.querySelectorAll('.qother')) stale.remove(); // a redraw for the next thread must not read the old thread's boxes as its own
  const waitingBar = $('waiting-bar'); if (waitingBar) { waitingBar.dataset.key = ''; delete waitingBar.dataset.question; }
  state.quote = null; hideQuotePop(); state.openId = id; state.detail = null; state.sheet = false; state.msgStop = null; $('cl-add').value = ''; state.shown = ''; state.clShown = ''; state.clEdit = null; state.captureFor = null; state.images = []; dropAll(state.files); state.gallery = []; state.replyTo = null; $('replybar').hidden = true; state.secrets.clear(); state.replacing.clear(); state.qopen = new Set(); state.keptShown = new Set(); closeMenu(false);
  $('text').value = id ? takeDraft(id) : ''; $('text').readOnly = false; growText(); drawPreviews($('previews'), state.images, noop); drawChips($('fchips'), state.files, redrawComposer); showError($('error'), '');
  $('placeholder').textContent = 'Select a thread, or start a new one.';
  drawThread(); drawList(); drawPinThread();
  if (id) loadThread(id);
  if (metrics) loadMetrics();
  if (tracker) loadTracker();
  if (artMatch) loadArtifact();
  if (artsPage) loadArtifactsPage();
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
    el('h3', { text: 'My sessions' }),
    el('p', { class: 'sub', text: 'Your own inbox recordings, only if you switched on "Record my inbox sessions" in your profile.' }),
    el('div', { id: 'my-sessions' }),
    el('p', { class: 'sub', style: 'margin-top:14px', text: `Days and hours are UTC. A thread counts as closed when its status last changed to done. Merged-away threads and ${agent}'s acknowledgements are not counted. Your actions: ${m.events.count} in ${wlabel}${m.events.count ? ` (${Object.entries(m.events.by_kind).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')})` : ''}.` }),
  ];
  const key = JSON.stringify([m.window, m.generated_at.slice(0, 16), state.profile, innerWidth]);
  if (key === state.mdrawn) return;
  state.mdrawn = key;
  body.replaceChildren(...sections);
  drawMySessions();
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
    state.mdata = data; drawMetrics(); void loadMySessions();
  } catch (error) { if (!state.mdata) { $('metrics-body').replaceChildren(el('p', { class: 'error', text: `Could not load the metrics: ${error.message}` })); state.mdrawn = ''; } }
}

// ---- Composer
// `/btw question` (or the Side question button) sends a side question: the prefix is dropped and the quote bar, if any, is left alone.
async function send(event, forceAside = false) {
  event.preventDefault();
  const id = state.openId, parsed = parseBtw($('text').value), aside = forceAside || parsed.aside, text = aside ? parsed.text : $('text').value;
  if (state.busy || !id) return;
  if (state.detail?.merged_into) return;
  if (aside && !text.trim() && !state.images.length && !state.files.length) { showError($('error'), 'Write your side question after /btw.'); $('text').focus(); return; }
  if (!text.trim() && !state.images.length && !state.files.length) return;
  if (state.detail?.read_only) { showError($('error'), 'This thread is read-only, so nothing can be sent or queued.'); return; }
  const cid = newCid(), written_at = new Date().toISOString(), reply_to = !aside && state.replyTo ? state.replyTo : undefined, quote = !aside && !reply_to ? quoteToSend(text) ?? undefined : undefined, images = [...state.images], files = [...state.files];
  state.busy = true; $('send').disabled = true; $('btw').disabled = true; showError($('error'), '');
  const cleared = () => { if (id === state.openId) { if (!aside) { state.replyTo = null; state.quote = null; } $('text').value = ''; state.images.length = 0; drawPreviews($('previews'), state.images, noop); state.files.length = 0; drawChips($('fchips'), state.files, redrawComposer); growText(); } };
  const queue = async () => { // the composer is emptied first, so anything typed while it is stored is not wiped
    const before = $('text').value, replying = state.replyTo, quoting = state.quote; cleared();
    // A file still on its way is stopped (its upload id is kept, so the queue carries on from there); a file already on the server is named by its id.
    for (const f of files) { f.controller?.abort(); }
    const held = files.map(f => ({ name: f.name, size: f.size, type: f.type, blob: f.file, ...(f.id ? { id: f.id } : {}), ...(f.uploadId && !f.id ? { uploadId: f.uploadId } : {}) }));
    try { await outbox.add({ cid, thread: id, text, images, files: held, reply_to, ...(quote ? { quote } : {}), aside, written_at }); } catch (error) { $('text').value = before; state.images.push(...images); state.files.push(...files); state.replyTo = replying; state.quote = quoting; redrawComposer(); throw error; }
    drawReplyBar();
  };
  try {
    // With no signal, or messages already waiting (they go first, to keep the order), the message joins the outbox.
    const offlineFiles = () => files.some(f => f.status !== 'done' && f.size > FILE_OFFLINE_MAX);
    if (isOffline() || outbox.pending()) {
      if (offlineFiles()) { showError($('error'), `A file over ${humanSize(FILE_OFFLINE_MAX)} needs a connection. Remove it, or send when you are online.`); return; }
      await queue(); return;
    }
    if (files.length) { // the message names its files once they are all on the server
      const ready = await ensureUploaded(files, redrawComposer);
      if (!ready.ok) {
        if (ready.network && !offlineFiles()) { await queue(); return; }
        showError($('error'), ready.reason); return;
      }
    }
    try {
      const sent = await post(`threads/${id}/messages`, { text, images, ...(files.length ? { attachments: files.map(f => f.id) } : {}), ...(aside ? { aside: true } : reply_to ? { reply_to } : quote ? { quote } : {}), client_id: cid, written_at });
      if (sent?.forwarded_to) {
        cleared();
        showToast('Sent in the merged thread');
        location.hash = `#/${sent.forwarded_to}`;
        return;
      }
    } catch (error) { if (error.network && !offlineFiles()) { await queue(); return; } throw error; }
    cleared();
    await Promise.all([loadThread(id), refreshList()]);
  } catch (error) { showError($('error'), error.message); }
  finally {
    state.busy = false;
    const merged = !!state.detail?.merged_into;
    $('send').disabled = merged; $('btw').disabled = merged;
    if (!merged) $('text').focus();
  }
}
const redrawComposer = () => { drawPreviews($('previews'), state.images, redrawComposer); drawChips($('fchips'), state.files, redrawComposer); };
async function toggleDone() {
  const d = state.detail; if (!d) return;
  try { await post(`threads/${d.id}/status`, { status: d.status === 'done' ? 'open' : 'done' }); await Promise.all([loadThread(d.id), refreshList()]); }
  catch (error) { showError($('error'), error.message); }
}

// ---- What this server offers: the key box target, whether Redact is on, and the package version. Unknown (offline, never loaded) draws neither action.
function drawUpdate(serverVersion) {
  if (typeof serverVersion === 'string') state.serverVersion = serverVersion;
  const banner = $('update-banner'); if (!banner) return;
  let dismissed = state.dismissedUpdate;
  try { const stored = localStorage.getItem(DISMISS_KEY); if (stored) dismissed = stored; } catch { /* the memory still holds a dismiss for this tab */ }
  const next = offeredVersion(LOADED, state.serverVersion, dismissed);
  banner.hidden = !next;
  $('update-text').textContent = next ? updateBannerText(next) : '';
}
function dismissUpdate() {
  const version = state.serverVersion; if (!version) return;
  state.dismissedUpdate = version;
  try { localStorage.setItem(DISMISS_KEY, version); } catch { /* session only */ }
  drawUpdate(version);
}
// Reload must take the new worker and the new shell: check for an update, let a waiting worker claim the tab, then load the page again.
async function reloadUpdated() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg) {
      await reg.update();
      const worker = reg.waiting;
      if (worker) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 2000);
          navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
          worker.postMessage({ type: 'SKIP_WAITING' });
        });
      }
    }
  } catch { /* the reload still fetches whatever the server is serving now */ }
  location.reload();
}
async function refreshConfig() {
  try {
    const c = await api('config');
    const next = { secret_target: typeof c.secret_target === 'string' ? c.secret_target : null, redact: c.redact === true };
    if (JSON.stringify(next) !== JSON.stringify(state.config)) { state.config = next; if (state.detail) drawMessages(state.detail); }
    drawUpdate(c.version);
  } catch { /* keep what we knew */ }
}
// ---- The phone's header ⋯ and composer ＋ menus: the same actions as the desktop buttons.
function openMoveMenu(anchor) {
  const items = state.projects.filter(p => p.id !== state.project).map(p => ({ label: p.name, onclick: () => { void moveToProject(p.id); } }));
  if (items.length) openMenu(anchor || $('more'), items);
}
async function moveToProject(projectId) {
  const d = state.detail; if (!d || state.busy) return;
  state.busy = true;
  try {
    const result = await post(`threads/${d.id}/move-project`, { project: projectId });
    state.project = result.project || projectId;
    try { localStorage.setItem(PROJECT_KEY, state.project); } catch { /* storage may be blocked */ }
    state.openId = null; state.detail = null; state.shown = '';
    await refreshProjects();
    const next = `#/${result.id}`;
    if (location.hash === next) route(); else location.hash = next;
  } catch (error) { showError($('error'), error.message); }
  finally { state.busy = false; }
}
function openMore() {
  const d = state.detail; if (!d) return;
  openMenu($('more'), [{ label: isPinned('thread', d.id) ? 'Unpin' : 'Pin', onclick: () => togglePin('thread', d.id) },
    ...(!d.merged_into && !d.read_only ? [{ label: 'Merge into…', onclick: openMerge }] : []),
    ...(state.projects.length > 1 && !d.merged_into ? [{ label: 'Move to project…', onclick: () => openMoveMenu($('more')) }] : []),
    { label: 'Reminders', onclick: openReminders },
    { label: d.status === 'done' ? 'Reopen' : 'Mark done', onclick: toggleDone },
    ...(COARSE && document.querySelector('.fb-launcher') ? [{ label: 'Feedback on this page', onclick: () => document.querySelector('.fb-launcher')?.click() }] : []),
    ...(d.read_only ? [{ note: "Read-only: updates only. You can't reply here." }] : []), ...(d.merged_into ? [{ note: 'This thread was merged into another one.' }] : []),
    ...(isPhone() && LOADED ? [{ note: `react-feedback v${LOADED}`, foot: true }] : [])]);
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
const redrawNew = () => { drawPreviews($('new-previews'), state.newImages, redrawNew); drawChips($('new-fchips'), state.newFiles, redrawNew); };
async function startThread(event) {
  event.preventDefault();
  showError($('new-error'), '');
  try {
    if (state.newFiles.length) {
      const ready = await ensureUploaded(state.newFiles, redrawNew);
      if (!ready.ok) { showError($('new-error'), ready.network ? 'Starting a thread with files needs a connection.' : ready.reason); return; }
    }
    const { id } = await post('threads', { title: $('new-title').value, text: $('new-text').value, images: state.newImages, ...(state.newFiles.length ? { attachments: state.newFiles.map(f => f.id) } : {}) });
    $('new-dialog').close(); $('new-form').reset(); state.newImages.length = 0; state.newFiles.length = 0; redrawNew();
    await refreshList(); location.hash = `#/${id}`;
  } catch (error) { showError($('new-error'), error.message); }
}
function openNew() { showError($('new-error'), ''); $('new-dialog').showModal(); $('new-title').focus(); }

// ---- Keyboard
const typing = t => !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
const anyDialog = () => [...document.querySelectorAll('dialog')].some(d => d.open);
// The sidebar collapses to a slim rail on wide screens (the CSS ignores it on a phone); the choice is kept on this device.
function setSidebar(collapsed, save) {
  $('app').classList.toggle('rail', collapsed);
  const t = $('side-toggle');
  t.setAttribute('aria-expanded', String(!collapsed));
  t.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  t.title = collapsed ? 'Expand sidebar ([)' : 'Collapse sidebar ([)';
  t.firstElementChild.textContent = collapsed ? '\u00bb' : '\u00ab';
  if (save) { try { localStorage.setItem(SIDE_KEY, collapsed ? '1' : '0'); } catch { /* storage may be blocked */ } }
}
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
  if (e.key === '[') { e.preventDefault(); setSidebar(!$('app').classList.contains('rail'), true); return; }
  if (e.shiftKey) return;
  if (e.target.classList?.contains('msg') && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) { e.preventDefault(); moveMsg(e.target, e.key === 'Home' ? 'start' : e.key === 'End' ? 'end' : e.key === 'ArrowDown' ? 1 : -1); return; }
  if (e.key === 'l' && state.detail) { e.preventDefault(); toggleChecklist(); return; }
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
  else if (e.key === 'e' && state.detail) { e.preventDefault(); toggleDone(); }
  else if (e.key === 'n') { e.preventDefault(); openNew(); }
  else if (e.key === 'p' && state.openId) { e.preventDefault(); togglePin('thread', state.openId); }
  else if (e.key === 'b' && state.detail && !state.detail.read_only) { e.preventDefault(); startAside(); }
  else if (e.key === 'q' && !$('qpop')?.hidden) { e.preventDefault(); $('qpop-note').focus(); }
  else if (e.key === 'r' && state.detail && !state.detail.read_only && e.target.closest?.('.msg[data-mid]')) { e.preventDefault(); startReply(e.target.closest('.msg').dataset.mid); }
  else if ((e.key === 'c' || e.key === 'y') && state.detail) { e.preventDefault(); focusAdd(e.key === 'c' ? 'agent' : 'user'); }
}

// ---- Wiring
paintKeys();
$('help-rows').replaceChildren(...SHORTCUTS.map(([k, what]) => el('tr', {}, el('td', {}, ...k.split(' / ').flatMap((part, i) => [...(i ? [' or '] : []), kbd(part)])), el('td', { text: what }))));
$('composer').addEventListener('submit', send);
document.addEventListener('selectionchange', scheduleSelection);
document.addEventListener('keyup', e => { if (e.shiftKey || e.key === 'Shift') scheduleSelection(); });
$('qpop')?.addEventListener('pointerdown', () => { qpop.hold = true; });
for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { if (qpop.hold) setTimeout(() => { qpop.hold = false; }, 600); });
$('qpop-go')?.addEventListener('click', takeQuote);
$('qpop-x')?.addEventListener('click', () => { window.getSelection?.()?.removeAllRanges(); hideQuotePop(); });
$('qpop-note')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); takeQuote(); } else if (e.key === 'Escape') { e.preventDefault(); hideQuotePop(); $('text').focus(); } });
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
$('update-reload').addEventListener('click', () => { void reloadUpdated(); });
$('update-dismiss').addEventListener('click', dismissUpdate);
paintVersion();
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
$('text').addEventListener('paste', e => { const pics = pastedImages(e), others = pastedFiles(e); if (pics.length || others.length) { e.preventDefault(); if (pics.length) addImages(state.images, pics, $('error'), redrawComposer); if (others.length) addFiles(state.files, others, $('error'), redrawComposer); } });
$('attach').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', e => { addImages(state.images, [...e.target.files], $('error'), redrawComposer); e.target.value = ''; });
$('attach-file').addEventListener('click', () => $('file-any').click());
$('file-any').addEventListener('change', e => { addFiles(state.files, [...e.target.files], $('error'), redrawComposer); e.target.value = ''; });
dragHooks($('thread-main'), 'thread', () => !!state.openId && !state.detail?.read_only);
$('toggle-done').addEventListener('click', toggleDone);
$('pin-thread').addEventListener('click', () => { if (state.openId) togglePin('thread', state.openId); });
$('merge-open').addEventListener('click', openMerge);
$('move-open')?.addEventListener('click', () => openMoveMenu($('move-open')));
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
$('new-text').addEventListener('paste', e => { const pics = pastedImages(e), others = pastedFiles(e); if (pics.length || others.length) { e.preventDefault(); if (pics.length) addImages(state.newImages, pics, $('new-error'), redrawNew); if (others.length) addFiles(state.newFiles, others, $('new-error'), redrawNew); } });
$('new-attach').addEventListener('click', () => $('new-file').click());
$('new-file').addEventListener('change', e => { addImages(state.newImages, [...e.target.files], $('new-error'), redrawNew); e.target.value = ''; });
$('new-attach-file').addEventListener('click', () => $('new-file-any').click());
$('new-file-any').addEventListener('change', e => { addFiles(state.newFiles, [...e.target.files], $('new-error'), redrawNew); e.target.value = ''; });
dragHooks($('new-dialog'), 'new');
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
$('side-toggle').addEventListener('click', () => setSidebar(!$('app').classList.contains('rail'), true));
try { if (localStorage.getItem(SIDE_KEY) === '1') setSidebar(true, false); } catch { /* storage may be blocked */ }
window.addEventListener('hashchange', route);
// "Claude · active 2 min ago" and "You · last seen 10:42": quiet, and gone when there is no data. The time after an hour is in this browser's zone.
const clockText = (iso, now) => { const d = new Date(iso), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === new Date(now).toDateString() ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`; };
function drawPresence() {
  const lines = presenceLines(state.presence, Date.now(), { agentName: state.profile.agent.name, clock: clockText, viewer: 'user' });
  const box = $('presence');
  box.hidden = !lines.length;
  box.replaceChildren(...lines.flatMap((l, i) => [...(i ? [el('span', { 'aria-hidden': 'true', text: ' · ' })] : []), el('span', { class: `pres ${l.who}`, 'data-who': l.who, text: l.text })]));
}
async function refreshPresence() {
  try { state.presence = await api('presence'); } catch { /* keep the last one */ }
  drawPresence();
}
function clip(text, n) {
  const flat = String(text || '').trim().replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
function liveQuestions(d) {
  if (!d || d.read_only || d.merged_into) return [];
  const answered = new Set((d.messages || []).flatMap(m => (m.answer ? [m.answer.question_id] : [])));
  return (d.messages || []).filter(m => m.author === 'agent' && m.question && !m.question.withdrawn && !m.question.reasked && !m.question.expired && !answered.has(m.question.id));
}
function drawWaiting(d) {
  const bar = $('waiting-bar'); if (!bar) return;
  const open = liveQuestions(d);
  if (!open.length) { bar.hidden = true; bar.replaceChildren(); bar.dataset.key = ''; delete bar.dataset.question; state.waitingOpen = false; return; }
  const newest = open[open.length - 1];
  const q = newest.question;
  const more = open.length - 1;
  const inline = open.length === 1 && q.options.length <= 4 && !q.multi;
  // A poll redraws the thread every few seconds; the bar is rebuilt only when what it shows changes,
  // so an answer being typed in it is never wiped. Typed text carries over a rebuild of the same question.
  const key = `${d.id}|${open.map(m => m.question.id).join(',')}|${inline ? 'inline' : state.waitingOpen ? 'open' : 'closed'}`;
  if (bar.dataset.key === key && bar.childElementCount) { bar.dataset.question = q.id; return; }
  const typed = (bar.dataset.question === q.id && (bar.dataset.key || '').split('|')[0] === d.id ? bar.querySelector('.qother')?.value || '' : '') || state.qsel[qk(q.id)]?.other || '';
  bar.dataset.key = key;
  bar.dataset.question = q.id;
  bar.hidden = false;
  const summary = el('span', { text: clip(q.prompt, 80) });
  if (inline) {
    const head = el('div', { class: 'waiting-head' }, el('strong', { text: 'Waiting for your answer' }), summary);
    const opts = el('div', { class: 'waiting-opts' }, ...q.options.map(o => el('button', { type: 'button', class: 'waiting-opt', onclick: () => { const s = selFor(q); s.ids = [o.id]; s.other = ''; void submitAnswer(q); } }, o.label)));
    const kids = [head, opts];
    if (q.allow_other) {
      const other = el('input', { type: 'text', class: 'qother', placeholder: 'Other (write your own answer)', maxlength: '1000', 'aria-label': 'Other answer' });
      if (typed) other.value = typed;
      other.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); const s = selFor(q); s.ids = []; s.other = other.value; void submitAnswer(q); } });
      kids.push(other);
    }
    bar.replaceChildren(...kids);
    return;
  }
  const head = el('button', { type: 'button', class: 'waiting-head', 'aria-expanded': String(!!state.waitingOpen), onclick: () => { state.waitingOpen = !state.waitingOpen; drawWaiting(d); } },
    el('strong', { text: 'Waiting for your answer' }), summary, ...(more ? [el('span', { class: 'hint', text: `${more} more` })] : []));
  bar.replaceChildren(head);
  if (state.waitingOpen) {
    bar.append(questionCard(d, newest));
    const other = bar.querySelector('.qother');
    if (typed && other && !other.value) other.value = typed;
  }
}
function pillText(a) {
  const links = a.links || 0; if (!links) return '';
  return `Shared · ${links} ${links === 1 ? 'link' : 'links'} · viewed ${a.views || 0}×`;
}
function artifactSrc(id, version) {
  const q = projectQuery();
  return `/__feedback/a/${id}/v${version}${q ? `?${q}` : ''}`;
}
function artifactCard(a) {
  const kids = [el('strong', { text: a.title }), el('span', { class: 'hint', text: `v${a.latest}` }), el('a', { href: `#/artifact/${a.id}`, text: 'Open' })];
  if (a.links) kids.push(el('button', { type: 'button', class: 'share-pill', onclick: () => { void openManage(a.id); } }, pillText(a)));
  if (a.suggest) kids.push(el('button', { type: 'button', class: 'primary', onclick: () => openShare(a.id) }, 'Share?'));
  return el('article', { class: 'art-card', 'data-artifact': a.id }, ...kids);
}
function drawArtifactCards(d) {
  const host = $('artifact-cards'); if (!host) return;
  const rows = d?.artifacts || [];
  host.replaceChildren(...rows.map(artifactCard));
}
// A badge for a project: its picture when the server has one, else up to two initials on a colour picked from the id (white text on each, enough contrast in light and dark).
const BADGE_COLOURS = ['#00796f', '#1f5fa8', '#8a3a8f', '#a3470f', '#b02f62', '#4d6b0f', '#3f4fa8', '#7a5a00'];
function badgeColour(id) { let h = 5381; for (const ch of String(id)) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0; return BADGE_COLOURS[h % BADGE_COLOURS.length]; }
function badgeInitials(name) {
  const words = String(name || '').match(/[\p{L}\p{N}]+/gu) || [];
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}
function fillBadge(node, p) {
  node.style.setProperty('--pb', badgeColour(p.id));
  node.dataset.project = p.id;
  node.textContent = badgeInitials(p.name);
  if (!p.has_icon) return;
  const img = el('img', { alt: '', src: `${API}projects/${encodeURIComponent(p.id)}/icon` });
  img.addEventListener('error', () => { node.textContent = badgeInitials(p.name); }); // a picture that fails leaves the initials
  node.replaceChildren(img);
}
function projectBadge(p) { const node = el('span', { class: 'pbadge', 'aria-hidden': 'true' }); fillBadge(node, p); return node; }
function drawProjects() {
  const box = $('project-switch');
  const move = $('move-open');
  const many = state.projects.length > 1;
  if (move) move.hidden = !many || !!state.detail?.merged_into;
  if (!box) return;
  box.hidden = !many;
  const title = $('app-title'); if (title) title.hidden = many; // with a project menu, the menu is the header
  if (!many) return;
  const current = state.projects.find(p => p.id === state.project) || state.projects[0];
  $('project-name').textContent = current?.name || 'Project';
  if ($('project-badge') && current) fillBadge($('project-badge'), current);
  $('project-menu').replaceChildren(...state.projects.map(p => el('button', { type: 'button', role: 'menuitem', 'aria-current': p.id === state.project ? 'true' : 'false', onclick: () => chooseProject(p.id) },
    el('span', { class: 'pname' }, projectBadge(p), el('span', { text: p.name })), el('span', { class: 'count', text: p.unread ? String(p.unread) : '' }))));
}
function chooseProject(id) {
  $('project-menu').hidden = true;
  $('project-button')?.setAttribute('aria-expanded', 'false');
  if (id === state.project) return;
  stopRecording(); // what it recorded goes to the project it was recording
  state.project = id;
  try { localStorage.setItem(PROJECT_KEY, id); } catch { /* storage may be blocked */ }
  state.threads = []; state.detail = null; state.openId = 'switching';
  if (location.hash !== '#/') location.hash = '#/';
  refreshList().then(() => { state.openId = 'switching'; route(); void refreshReplaySetting(); });
}
async function refreshProjects() {
  let data = null;
  try { data = await api('projects'); } catch { data = null; }
  if (!data || !Array.isArray(data.projects)) { drawProjects(); return; }
  const list = data.projects;
  state.projects = list;
  state.defaultProject = list[0]?.id || '';
  let saved = '';
  try { saved = localStorage.getItem(PROJECT_KEY) || ''; } catch { saved = ''; }
  if (!state.project || !list.some(p => p.id === state.project)) state.project = list.some(p => p.id === saved) ? saved : state.defaultProject;
  drawProjects();
}
function shareLink(path) { return `${location.origin}${path}`; }
function openShare(id) {
  state.shareFor = id; state.sharePending = null;
  showError($('share-error'), '');
  $('share-url').hidden = true; $('share-url').textContent = '';
  $('share-copy').hidden = true; $('share-create').hidden = false;
  const picked = document.querySelector('input[name="share-exp"][value="7d"]'); if (picked) picked.checked = true;
  if ($('share-latest')) $('share-latest').checked = false;
  if ($('share-record')) $('share-record').checked = false; // recording is off until the owner switches it on
  $('share-dialog').showModal();
}
function showShareLink(path) {
  const url = shareLink(path);
  $('share-url').hidden = false; $('share-url').textContent = url;
  $('share-copy').hidden = false; $('share-create').hidden = true;
  $('share-copy').onclick = async () => { try { await navigator.clipboard.writeText(url); $('share-copy').textContent = 'Copied'; } catch { $('share-copy').textContent = 'Copy failed'; } };
}
async function createUserShare(confirm) {
  const id = state.shareFor; if (!id) return;
  const expires = document.querySelector('input[name="share-exp"]:checked')?.value || '7d';
  const latest = !!$('share-latest')?.checked;
  const record = !!$('share-record')?.checked;
  try {
    const created = await post(`artifacts/${id}/share`, { expires, latest, ...(record ? { record: true } : {}), ...(confirm ? { confirm: true } : {}) });
    showShareLink(created.url);
    if (state.openId) await loadThread(state.openId, { quiet: true });
    if (state.artifactOn) await loadArtifact();
    if (state.artifactsOn) await loadArtifactsPage();
  } catch (error) {
    if (!confirm && /looks like it contains/.test(error.message)) {
      $('share-warn-text').textContent = error.message;
      $('share-dialog').close();
      $('share-warn').showModal();
      return;
    }
    showError($('share-error'), error.message);
    if (!$('share-dialog').open) $('share-dialog').showModal();
  }
}
function linkRow(link, title) {
  const version = link.version === 'latest' ? 'latest' : `v${link.version}`;
  const viewed = `Viewed ${link.views}×${link.last_viewed_at ? ` · last ${when(link.last_viewed_at)}` : ''}`;
  return el('article', { class: 'share-card' },
    el('div', { class: 'share-card-main' },
      ...(title ? [el('a', { href: `#/artifact/${link.artifact}`, text: title })] : []),
      el('p', { class: 'share-who' }, el('strong', { text: link.created_by })),
      el('p', { text: `Created ${when(link.created_at)}` }),
      el('p', { text: link.expires_at ? `Expires ${link.expires_at.slice(0, 10)}` : 'No expiry' }),
      el('p', { text: `Version ${version}` }),
      el('p', { text: viewed }),
      el('p', { text: `Feedback from viewers: ${link.feedback || 0}` }),
      el('label', { class: 'rec-switch' }, el('input', { type: 'checkbox', 'data-record': link.id, ...(link.record ? { checked: '' } : {}), onchange: e => { void setRecording(link, e.currentTarget); } }), 'Record interactions')),
    el('button', { type: 'button', onclick: () => { void revokeShare(link.id); } }, 'Revoke'));
}
function drawManage(links) {
  $('manage-list').replaceChildren(...(links.length ? links.map(link => linkRow(link)) : [el('p', { text: 'No active links.' })]));
}
// The owner's switch for one link. A failure puts the box back.
async function setRecording(link, box) {
  const on = box.checked;
  try {
    await post(`shares/${link.id}/record`, { on });
    link.record = on;
    if (state.artifactOn) await loadArtifact();
  } catch (error) { box.checked = !on; box.setCustomValidity?.(error.message); box.title = error.message; }
}
async function openManage(id) {
  state.manageFor = id;
  const meta = await api(`artifacts/${id}`);
  drawManage(meta.shares || []);
  $('manage-dialog').showModal();
}
async function revokeShare(id) {
  await post(`shares/${id}/revoke`, {});
  if (state.openId) await loadThread(state.openId, { quiet: true });
  if (state.artifactOn) await loadArtifact();
  if (state.artifactsOn) await loadArtifactsPage();
  if ($('manage-dialog')?.open && state.manageFor) { const meta = await api(`artifacts/${state.manageFor}`); drawManage(meta.shares || []); }
}
function removeArtifactFrame() {
  const frame = $('artifact-frame');
  if (!frame) return;
  frame.removeAttribute('src');
  frame.remove();
}
function artifactFrame(src) {
  const host = $('artifact-stage') || $('artifact');
  if (!host) return;
  let frame = $('artifact-frame');
  if (!frame) {
    frame = el('iframe', { id: 'artifact-frame', sandbox: 'allow-scripts allow-popups', referrerpolicy: 'no-referrer', title: 'Artifact' });
    host.append(frame);
  }
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
}
function drawVersionPicker(meta, version) {
  const select = $('artifact-version');
  if (!select) return;
  const versions = (meta.versions || []).map(item => (typeof item === 'number' ? item : item.n));
  const want = versions.length ? versions : [version];
  const signature = want.join(',');
  if (select.dataset.versions !== signature) {
    select.replaceChildren(...want.map(n => el('option', { value: String(n), text: `v${n}` })));
    select.dataset.versions = signature;
  }
  select.value = String(version);
  select.onchange = () => {
    const n = Number(select.value);
    if (!Number.isInteger(n) || n < 1) return;
    const next = `#/artifact/${meta.id}/v${n}`;
    if (location.hash !== next) location.hash = next;
  };
}
function drawArtifact(meta, version) {
  $('artifact-title').textContent = meta.title;
  document.title = `${meta.title} · Artifact`;
  artifactFrame(artifactSrc(meta.id, version));
  drawVersionPicker(meta, version);
  const pill = $('artifact-pill');
  if (meta.links) { pill.textContent = pillText(meta); pill.onclick = () => { void openManage(meta.id); }; pill.hidden = false; }
  else pill.hidden = true;
  $('artifact-share').onclick = () => openShare(meta.id);
  drawArtifactTabs(meta, version);
}
async function loadArtifact() {
  const id = state.artifactId; if (!id) return;
  try {
    const meta = await api(`artifacts/${id}`);
    if (state.artifactId !== id) return;
    state.artifact = meta;
    drawArtifact(meta, state.artifactVer || meta.latest);
  } catch (error) { if ($('artifact-title')) $('artifact-title').textContent = error.message; }
}
async function loadArtifactsPage() {
  try {
    const [list, shared] = await Promise.all([api('artifacts'), api('shares')]);
    if (!state.artifactsOn) return;
    $('artifacts-list').replaceChildren(...(list.length ? list.map(artifactCard) : [el('p', { class: 'hint', text: 'No artifacts yet.' })]));
    $('shared-list').replaceChildren(...(shared.length ? shared.map(link => linkRow(link, link.title || link.artifact)) : [el('p', { class: 'hint', text: 'No active links.' })]));
  } catch (error) { $('artifacts-list')?.replaceChildren(el('p', { class: 'error', text: error.message })); }
}
// ---- Replays. A shared page's recordings sit under its artifact (a Replays tab, and a Heatmap over the page); your own inbox sessions sit under Metrics.
// The player is a page of the feedback server's own, with a strict CSP; the recording is rebuilt only inside an iframe that runs no scripts.
const BASE = API.replace(/api\/$/, '');
function drawArtifactTabs(meta, version) {
  const replays = state.artTab === 'replays';
  $('tab-page').setAttribute('aria-pressed', String(!replays)); $('tab-replays').setAttribute('aria-pressed', String(replays));
  $('artifact-stage').hidden = replays; $('replays-panel').hidden = !replays;
  $('artifact-heat').hidden = replays; $('artifact-heat').setAttribute('aria-pressed', String(state.heat));
  if (replays) void loadReplays(meta);
  void drawHeat(meta, version);
}
async function loadReplays(meta) {
  try {
    const rows = await api(`artifacts/${meta.id}/replays`);
    if (state.artifactId !== meta.id || state.artTab !== 'replays') return;
    state.replays = rows; drawReplays(meta);
  } catch (error) { $('replays-list').replaceChildren(el('p', { class: 'error', text: `Could not load the replays: ${error.message}` })); state.replaysDrawn = ''; }
}
function sessionRow(r, { artifact, onDelete, linkText }) {
  const path = artifact ? `artifacts/${artifact}/replays/${r.session}` : `replays/${r.session}`;
  const confirming = state.replayDel === r.session;
  return el('article', { class: 'replay-row', 'data-session': r.session },
    el('div', { class: 'info' }, el('strong', { text: when(r.started_at) }), el('span', { text: `${replaySummary(r)}${linkText ? ` · ${linkText}` : ''}` })),
    el('button', { type: 'button', class: 'primary', 'aria-label': `Play the recording from ${when(r.started_at)}`, onclick: () => { void playReplay(path, `${when(r.started_at)} · ${replaySummary(r)}`); } }, 'Play'),
    el('button', { type: 'button', 'aria-label': `${confirming ? 'Confirm: delete' : 'Delete'} the recording from ${when(r.started_at)}`, onclick: () => {
      if (!confirming) { state.replayDel = r.session; onDelete(); setTimeout(() => { if (state.replayDel === r.session) { state.replayDel = null; onDelete(); } }, 4000); return; }
      state.replayDel = null;
      void api(path, { method: 'DELETE' }).then(onDelete.reload, error => { showError($('error'), error.message); onDelete(); });
    } }, confirming ? 'Confirm delete' : 'Delete'));
}
function drawReplays(meta) {
  const rows = state.replays;
  const key = JSON.stringify([rows.map(r => [r.session, r.duration_ms, r.clicks]), state.replayDel]);
  if (key === state.replaysDrawn) return;
  state.replaysDrawn = key;
  $('replays-sub').textContent = rows.length ? `${rows.length} ${rows.length === 1 ? 'recording' : 'recordings'}. Viewers were told the page records clicks and mouse movement, and could opt out. Kept for the retention period, then deleted.` : 'No recordings yet. Switch on Record interactions for a shared link, and viewers are told and can opt out.';
  const redraw = () => { state.replaysDrawn = ''; drawReplays(meta); };
  redraw.reload = () => loadReplays(meta);
  $('replays-list').replaceChildren(...rows.map(r => sessionRow(r, { artifact: meta.id, onDelete: redraw, linkText: r.link ? `link ${r.link}` : '' })));
}
async function drawHeat(meta, version) {
  const on = state.heat && state.artTab === 'page';
  $('artifact-heat').setAttribute('aria-pressed', String(state.heat));
  $('heatmap').hidden = !on; $('heatmap-note').hidden = !on;
  if (!on) return;
  try {
    const data = await api(`artifacts/${meta.id}/heatmap?version=${version}`);
    if (state.artifactId !== meta.id || !state.heat) return;
    state.heatData = { ...data, version }; paintHeat();
  } catch (error) { $('heatmap-note').textContent = `Could not load the heatmap: ${error.message}`; }
}
function paintHeat() {
  const d = state.heatData, stage = $('artifact-stage');
  if (!d || !stage || $('heatmap').hidden) return;
  const spots = heatPositions(d.clicks, stage.clientWidth, stage.clientHeight);
  $('heatmap').replaceChildren(...spots.map(p => el('div', { class: 'dot', style: `left:${p.left}px;top:${p.top}px` })));
  $('heatmap-note').textContent = d.sessions ? `${d.clicks.length} ${d.clicks.length === 1 ? 'click' : 'clicks'} from ${d.sessions} ${d.sessions === 1 ? 'recording' : 'recordings'} of v${d.version}` : `No recordings of v${d.version} yet`;
}
let replayListener = null;
async function playReplay(path, label) {
  const dialog = $('replay-dialog'), frame = $('replay-frame');
  let data;
  try { data = await api(path); } catch (error) { showError($('error'), error.message); return; }
  $('replay-meta').textContent = label;
  dialog.showModal();
  const width = Math.max(240, Math.min(1000, frame.clientWidth || 600));
  const height = Math.max(160, Math.round(Math.min(frame.clientHeight || 400, width * 0.62) - 90));
  if (replayListener) window.removeEventListener('message', replayListener);
  replayListener = event => {
    if (event.source !== frame.contentWindow || !event.data) return;
    if (event.data.rf === 'player-ready') frame.contentWindow.postMessage({ rf: 'play', events: data.events, width, height }, '*');
    else if (event.data.rf === 'player-error') $('replay-meta').textContent = `${label} · could not play: ${String(event.data.message).slice(0, 120)}`;
  };
  window.addEventListener('message', replayListener);
  frame.setAttribute('src', `${BASE}replay/player`);
}
function closeReplay() {
  if (replayListener) { window.removeEventListener('message', replayListener); replayListener = null; }
  $('replay-frame').removeAttribute('src');
  if ($('replay-dialog').open) $('replay-dialog').close();
}
// Your own inbox sessions (Metrics, My sessions).
async function loadMySessions() {
  try { state.mysessions = await api('replays'); } catch { if (!state.mysessions) state.mysessions = []; }
  drawMySessions();
}
function drawMySessions() {
  const host = $('my-sessions'); if (!host) return;
  const rows = state.mysessions || [];
  if (!rows.length) { host.replaceChildren(el('p', { class: 'sub', text: state.recordInbox ? 'Nothing recorded yet.' : 'Nothing recorded. Switch on "Record my inbox sessions" in your profile.' })); return; }
  const redraw = () => drawMySessions();
  redraw.reload = () => loadMySessions();
  host.replaceChildren(...rows.map(r => sessionRow(r, { artifact: null, onDelete: redraw })));
}
// Recording the inbox itself: off until switched on in the profile. All text and inputs are masked (inbox mode), and the page shows "Recording" while it runs.
function loadRecorder() {
  return new Promise((resolve, reject) => {
    if (window.RFRecorder) { resolve(window.RFRecorder); return; }
    const script = document.createElement('script');
    script.src = `${BASE}replay/recorder.js`;
    script.onload = () => (window.RFRecorder ? resolve(window.RFRecorder) : reject(new Error('The recorder did not load.')));
    script.onerror = () => reject(new Error('The recorder did not load.'));
    document.head.append(script);
  });
}
async function flushRecording(r) {
  if (r.sending || r.stopped || !r.buf.length) return;
  const events = r.buf; r.buf = []; r.sending = true;
  try {
    const body = JSON.stringify({ session: r.session, seq: r.seq, events });
    const response = await fetch(`${API}replays${r.query ? `?${r.query}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 });
    if (response.ok) r.seq++;
    else if (response.status === 429 || response.status >= 500) r.buf = events.concat(r.buf);
    else { if (response.status === 403) state.recordInbox = false; stopRecording(); } // switched off elsewhere, or the recording is full
  } catch { r.buf = events.concat(r.buf); }
  r.sending = false;
}
async function startRecording() {
  if (state.recorder) return;
  let recorder;
  try { recorder = await loadRecorder(); } catch { return; }
  if (state.recorder || !state.recordInbox) return;
  const r = { session: newSessionId(), seq: 0, buf: [], sending: false, stopped: false, stop: null, timer: null, query: projectQuery() };
  r.stop = recorder.start({ inbox: true, emit: event => { r.buf.push(event); if (r.buf.length >= 400) void flushRecording(r); } });
  r.timer = setInterval(() => { void flushRecording(r); }, 5000);
  state.recorder = r;
  $('rec-dot').hidden = false; if ($('rec-mini')) $('rec-mini').hidden = false;
}
function stopRecording() {
  const r = state.recorder;
  $('rec-dot').hidden = true; if ($('rec-mini')) $('rec-mini').hidden = true;
  if (!r) return;
  state.recorder = null;
  try { r.stop?.(); } catch { /* already stopped */ }
  clearInterval(r.timer);
  if (state.recordInbox) void flushRecording(r).then(() => { r.stopped = true; }); else r.stopped = true; // what is left goes out once
}
async function refreshReplaySetting() {
  try {
    const setting = await api('replay-settings');
    state.recordInbox = setting.record_inbox === true;
  } catch { return; }
  if (state.recordInbox) void startRecording(); else stopRecording();
}
addEventListener('pagehide', () => { if (state.recorder) void flushRecording(state.recorder); });
$('tab-page')?.addEventListener('click', () => { state.artTab = 'page'; if (state.artifact) drawArtifactTabs(state.artifact, state.artifactVer || state.artifact.latest); });
$('tab-replays')?.addEventListener('click', () => { state.artTab = 'replays'; state.replaysDrawn = ''; if (state.artifact) drawArtifactTabs(state.artifact, state.artifactVer || state.artifact.latest); });
$('artifact-heat')?.addEventListener('click', () => { state.heat = !state.heat; if (state.artifact) drawArtifactTabs(state.artifact, state.artifactVer || state.artifact.latest); });
$('replay-close')?.addEventListener('click', closeReplay);
$('replay-dialog')?.addEventListener('close', () => { $('replay-frame').removeAttribute('src'); });
window.addEventListener('resize', () => { if (state.heat) paintHeat(); });
$('project-button')?.addEventListener('click', () => {
  const menu = $('project-menu'); if (!menu) return;
  menu.hidden = !menu.hidden;
  $('project-button').setAttribute('aria-expanded', String(!menu.hidden));
});
$('artifact-back')?.addEventListener('click', () => { location.hash = '#/'; });
$('artifacts-back')?.addEventListener('click', () => { location.hash = '#/'; });
$('share-form')?.addEventListener('submit', e => { e.preventDefault(); void createUserShare(false); });
$('share-cancel')?.addEventListener('click', () => $('share-dialog').close());
$('share-warn-cancel')?.addEventListener('click', () => $('share-warn').close());
$('share-warn-go')?.addEventListener('click', () => { $('share-warn').close(); $('share-dialog').showModal(); void createUserShare(true); });
$('manage-close')?.addEventListener('click', () => $('manage-dialog').close());
async function poll() {
  if (document.visibilityState !== 'visible') return;
  await Promise.all([refreshList(), refreshProfile(), refreshPins(), refreshConfig(), refreshPresence(), refreshProjects()]);
  if (state.openId) await loadThread(state.openId, { quiet: true });
  if (state.metricsOn) await loadMetrics();
  if (state.trackerOn) await loadTracker();
  if (state.artifactOn) await loadArtifact();
  if (state.artifactsOn) await loadArtifactsPage();
}
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);
drawMe();
refreshPins();
fitViewport(); drawOffline(); outbox.start();
Promise.all([refreshProfile(), refreshAreas(), refreshConfig(), refreshProjects()]).then(refreshList).then(route).then(refreshPresence).then(refreshReplaySetting);
