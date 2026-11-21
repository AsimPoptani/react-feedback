// "Open on phone" and the paired-devices page. No build, no deps. All text goes through textContent; the QR code is drawn as SVG shapes from the encoder's module grid.
// The code travels in the URL fragment (#/pair/<code>), which a browser never sends to a server, a proxy or a log.
const STYLE = `
.pair-link { flex: 1 0 100%; justify-content: center; cursor: pointer; font: inherit; font-weight: 700; }
dialog.pair { max-width: min(460px, 94vw); max-height: 94dvh; overflow-y: auto; overscroll-behavior: contain; }
dialog.pair h2 { margin: 0 0 6px; }
dialog.pair p { margin: 6px 0; }
dialog.pair .hint, .pair-page .hint { color: var(--ink-2); font-size: 14px; }
dialog.pair .qr { display: flex; justify-content: center; margin: 10px 0; }
dialog.pair .qr svg { width: min(280px, 72vw); height: auto; background: #fff; border-radius: 8px; display: block; }
dialog.pair .linkrow { display: flex; gap: 8px; align-items: stretch; }
dialog.pair .linkrow input { flex: 1; min-width: 0; font: 13px var(--f-mono, ui-monospace, monospace); border: 2px solid var(--ink); border-radius: 10px; padding: 6px 8px; background: var(--white); color: var(--ink); }
dialog.pair .count { font-variant-numeric: tabular-nums; font-weight: 700; }
dialog.pair .done { color: var(--teal); font-weight: 700; }
dialog.pair .actions, .pair-page .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
dialog.pair button, .pair-page button { min-height: 44px; }
.pair-page { position: fixed; inset: 0; z-index: 90; background: var(--paper); color: var(--ink); display: flex; flex-direction: column; min-height: 0; }
.pair-page[hidden] { display: none; }
.pair-page header { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--rule); flex-wrap: wrap; }
.pair-page header h2 { margin: 0; flex: 1; font: 800 20px var(--f-display, system-ui); }
.pair-page .body { overflow: auto; padding: 12px 16px calc(16px + env(safe-area-inset-bottom)); max-width: 720px; width: 100%; margin: 0 auto; box-sizing: border-box; }
.pair-page ul { list-style: none; margin: 0; padding: 0; }
.pair-page li { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--rule); }
.pair-page li .what { min-width: 0; flex: 1 1 200px; }
.pair-page li strong { overflow-wrap: anywhere; }
.pair-page li small { display: block; color: var(--ink-2); }
.pair-page .badge { display: inline-block; margin-left: 6px; padding: 0 8px; border-radius: 999px; background: var(--teal-tint); color: var(--ink); font-size: 12px; font-weight: 700; }
.pair-banner { position: fixed; left: 0; right: 0; top: 0; z-index: 120; background: var(--berry); color: var(--paper); padding: 12px 16px; font-weight: 700; text-align: center; }
`;
const COUNT_TICK = 1000;
const POLL_PAIRED = 3000;

export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// The link a phone opens. `base` is the public address (no trailing slash); `inboxPath` is where the inbox lives on that address (normally /__feedback/inbox/).
export function pairUrl(base, inboxPath, code, { thread = '', project = '' } = {}) {
  const query = new URLSearchParams();
  if (/^[\w-]{1,64}$/.test(thread)) query.set('to', thread);
  if (/^[\w-]{1,64}$/.test(project)) query.set('project', project);
  const tail = query.toString();
  return `${base.replace(/\/+$/, '')}${inboxPath}#/pair/${code}${tail ? `?${tail}` : ''}`;
}
// Where the link points, and whether that is a promise or a guess.
export function chooseBase(status, origin) {
  if (status?.public_url) return { base: status.public_url, guess: false };
  return { base: origin, guess: true };
}
const isLocalHost = base => { try { const h = new URL(base).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local'); } catch { return true; } };

const SVGNS = 'http://www.w3.org/2000/svg';
// The QR code as SVG shapes (black on white, with a quiet zone), from the encoder's module grid. Never HTML.
export async function qrSvg(text) {
  const { default: qrcode } = await import('./qr.js');
  const qr = qrcode(0, 'M');
  qr.addData(text); qr.make();
  const n = qr.getModuleCount(), quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + quiet * 2} ${n + quiet * 2}`);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code to open this inbox on your phone');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const back = document.createElementNS(SVGNS, 'rect');
  back.setAttribute('width', String(n + quiet * 2)); back.setAttribute('height', String(n + quiet * 2)); back.setAttribute('fill', '#fff');
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', '#000');
  svg.append(back, path);
  return svg;
}

function ensureStyle() {
  if (document.getElementById('pair-style')) return;
  const style = document.createElement('style'); style.id = 'pair-style'; style.textContent = STYLE; document.head.append(style);
}
let started = null;
// A coarse pointer is a phone or tablet. A device with `current: true` in the devices list is this browser, served by the remote listener. Neither should offer to pair another device.
const coarsePointer = () => !!matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
export function initPair({ api, el, showToast, context, openLabel = 'Open on phone' }) {
  if (started) return started;
  ensureStyle();
  let remoteClient = false;
  const offerPhone = () => !coarsePointer() && !remoteClient;
  function syncPhoneOffer() {
    const hide = !offerPhone();
    const link = document.getElementById('phone-link');
    if (link) link.hidden = hide;
    const header = document.getElementById('phone-open');
    if (header) header.hidden = hide;
  }
  const inboxPath = new URL('./', location.href).pathname;
  const send = (path, method) => api(path, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  let page = null, pageReturn = null;

  // ---- The "Open on phone" dialog
  async function openPhone(thread) {
    const dialog = el('dialog', { class: 'pair', 'aria-labelledby': 'pair-title' });
    const title = el('h2', { id: 'pair-title', text: 'Continue on your phone' });
    const body = el('div', {});
    const actions = el('div', { class: 'actions' });
    dialog.append(title, body, actions);
    document.body.append(dialog);
    let codeId = null, timer = 0, poll = 0, expiresAt = 0, paired0 = null, disposed = false;
    const close = () => {
      disposed = true; clearInterval(timer); clearInterval(poll);
      if (codeId) { const id = codeId; codeId = null; void send(`pair/codes/${id}`, 'DELETE').catch(() => {}); } // an unused code does not wait out its five minutes
      if (dialog.open) dialog.close();
      dialog.remove();
    };
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    const button = (text, onclick, props = {}) => el('button', { type: 'button', onclick, ...props }, text);
    const closeBtn = button('Close', close);
    const devicesBtn = button('Paired devices', () => { close(); openDevices(); });
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    body.append(el('p', { class: 'hint', text: 'Getting a code...' }));
    actions.append(closeBtn);

    let status;
    try { status = await api('pair/status'); } catch (error) { body.replaceChildren(el('p', { class: 'error', text: error.message })); return; }
    if (disposed) return;
    if (!status.remote) {
      body.replaceChildren(
        el('p', { text: 'Remote mode is off, so a phone cannot reach this inbox yet.' }),
        el('p', { class: 'hint' }, 'Restart the server with ', el('code', { text: 'react-feedback serve --remote' }), ', then open this box again. It starts a quick tunnel if cloudflared is installed; otherwise set ', el('code', { text: 'FEEDBACK_PUBLIC_URL' }), ' and point your own tunnel or proxy at the remote port.'));
      actions.replaceChildren(devicesBtn, closeBtn);
      return;
    }
    const { base, guess } = chooseBase(status, location.origin);
    const ctx = context?.() ?? {};
    const qrBox = el('div', { class: 'qr' });
    const linkInput = el('input', { type: 'text', readonly: '', 'aria-label': 'Link to open on your phone', onfocus: e => e.target.select() });
    const copy = button('Copy', async () => { try { await navigator.clipboard.writeText(linkInput.value); showToast('Link copied'); } catch { linkInput.select(); showToast('Press copy to copy the link'); } });
    const count = el('span', { class: 'count', role: 'timer', 'aria-label': 'Time left' });
    const note = el('p', { class: 'hint', 'aria-live': 'polite' });
    const state = el('p', { 'aria-live': 'polite' });
    body.replaceChildren(
      el('p', { class: 'hint', text: `Scan with your phone's camera${thread ? ' to open this thread there' : ''}. The link works once and expires in five minutes.` }),
      qrBox, el('div', { class: 'linkrow' }, linkInput, copy),
      el('p', { class: 'hint' }, 'Expires in ', count), note, state);
    if (guess) note.textContent = `No public address is set, so this link uses ${base}. Your phone must be able to reach that address; otherwise set FEEDBACK_PUBLIC_URL or install cloudflared.${isLocalHost(base) ? ' That is this computer only.' : ''}`;
    const tick = () => {
      const left = (expiresAt - Date.now()) / 1000;
      count.textContent = formatCountdown(left);
      if (left <= 0 && !disposed) { clearInterval(timer); qrBox.replaceChildren(); linkInput.value = ''; state.textContent = 'This code has expired.'; count.textContent = '0:00'; renewBtn.hidden = false; }
    };
    const renewBtn = button('New code', () => { void fresh(); }, { hidden: '' });
    async function fresh() {
      renewBtn.hidden = true; state.textContent = ''; state.className = '';
      if (codeId) { const id = codeId; codeId = null; void send(`pair/codes/${id}`, 'DELETE').catch(() => {}); }
      try {
        const made = await send('pair/codes', 'POST');
        if (disposed) { void send(`pair/codes/${made.id}`, 'DELETE').catch(() => {}); return; }
        codeId = made.id; expiresAt = Date.parse(made.expires_at);
        const link = pairUrl(base, inboxPath, made.code, { thread: thread || ctx.thread, project: ctx.project });
        linkInput.value = link;
        qrBox.replaceChildren(await qrSvg(link));
        clearInterval(timer); timer = setInterval(tick, COUNT_TICK); tick();
      } catch (error) { state.textContent = error.message; renewBtn.hidden = false; }
    }
    actions.replaceChildren(renewBtn, devicesBtn, closeBtn);
    await fresh();
    // When the phone has paired, say so.
    try { paired0 = (await api('devices')).devices.length; } catch { paired0 = null; }
    poll = setInterval(async () => {
      if (disposed || paired0 === null) return;
      try {
        const list = (await api('devices')).devices;
        if (list.length > paired0) { const newest = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]; state.textContent = `Paired: ${newest?.name || 'a device'}. You can close this.`; state.className = 'done'; clearInterval(timer); qrBox.replaceChildren(); linkInput.value = ''; count.textContent = '0:00'; codeId = null; paired0 = list.length; }
      } catch { /* try again on the next beat */ }
    }, POLL_PAIRED);
  }

  // ---- The paired devices page
  function closeDevices() { if (!page) return; page.remove(); page = null; document.removeEventListener('keydown', onKey, true); pageReturn?.focus?.(); pageReturn = null; }
  function onKey(e) { if (e.key === 'Escape' && page) { e.preventDefault(); e.stopPropagation(); closeDevices(); } }
  async function openDevices() {
    if (page) return;
    pageReturn = document.activeElement;
    const list = el('ul', { 'aria-label': 'Paired devices' });
    const summary = el('p', { class: 'hint', role: 'status' });
    const error = el('p', { class: 'error', role: 'alert', hidden: '' });
    const revokeAll = el('button', { type: 'button', class: 'danger' }, 'Revoke all');
    const back = el('button', { type: 'button', onclick: closeDevices, 'aria-label': 'Close paired devices' }, '← Back');
    page = el('section', { class: 'pair-page', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'devices-title' },
      el('header', {}, back, el('h2', { id: 'devices-title', text: 'Paired devices' }), revokeAll),
      el('div', { class: 'body' }, summary, error, list));
    document.body.append(page);
    document.addEventListener('keydown', onKey, true);
    back.focus();
    const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const fail = e => { error.textContent = e.message; error.hidden = false; };
    let armed = 0;
    revokeAll.addEventListener('click', async () => {
      if (!armed) { revokeAll.textContent = 'Really revoke all?'; armed = setTimeout(() => { armed = 0; revokeAll.textContent = 'Revoke all'; }, 4000); return; }
      clearTimeout(armed); armed = 0; revokeAll.textContent = 'Revoke all';
      try { await send('devices/revoke-all', 'POST'); showToast('All devices revoked'); await load(); } catch (e) { fail(e); }
    });
    async function load() {
      let data;
      try { data = await api('devices'); } catch (e) { fail(e); return; }
      error.hidden = true;
      const devices = data.devices;
      revokeAll.hidden = !devices.length;
      summary.textContent = devices.length ? `${devices.length} paired device${devices.length === 1 ? '' : 's'}. Revoking one signs it out at once.` : 'No device is paired. Use Open on phone to pair one.';
      list.replaceChildren(...devices.map(d => el('li', { 'data-device': d.id },
        el('div', { class: 'what' }, el('strong', { text: d.name }), ...(d.current ? [el('span', { class: 'badge', text: 'This device' })] : []),
          el('small', { text: `Paired ${when(d.created_at)}` }), el('small', { text: `Last seen ${when(d.last_seen_at)}` })),
        el('button', { type: 'button', class: 'danger', 'aria-label': `Revoke ${d.name}, paired ${when(d.created_at)}`, onclick: async () => {
          try { await send(`devices/${d.id}`, 'DELETE'); showToast('Device revoked'); await load(); } catch (e) { fail(e); }
        } }, 'Revoke'))));
    }
    await load();
  }

  // ---- Entry points: the sidebar footer, and a button in the thread header (the thread's own page opens on the phone)
  const foot = document.querySelector('.foot-links');
  if (foot) {
    const link = el('button', { type: 'button', class: 'metrics-link pair-link', id: 'phone-link', onclick: () => openPhone(context?.().thread || '') }, `\u{1F4F1} ${openLabel}`);
    foot.insertBefore(link, foot.querySelector('.ver'));
  }
  const more = document.getElementById('more');
  if (more?.parentNode) more.parentNode.insertBefore(el('button', { type: 'button', class: 'desk', id: 'phone-open', onclick: () => openPhone(context?.().thread || '') }, `\u{1F4F1} ${openLabel}`), more);
  syncPhoneOffer();
  // The devices list marks this browser when the page was served by the remote listener. A failure only means we cannot tell, so the desktop button stays.
  void api('devices').then(data => {
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    if (devices.some(d => d && d.current)) { remoteClient = true; syncPhoneOffer(); }
  }).catch(() => {});
  started = { openPhone, openDevices, offerPhone };
  return started;
}

// A request answered 401 on a paired phone means the device was revoked or expired: say so, plainly, once.
let shownUnpaired = false;
export function notifyUnpaired() {
  if (shownUnpaired || !document.body) return;
  shownUnpaired = true;
  const banner = document.createElement('div');
  banner.className = 'pair-banner'; banner.setAttribute('role', 'alert');
  banner.textContent = 'This device is no longer paired. Scan a new QR code from the inbox on your computer.';
  ensureStyle();
  document.body.append(banner);
}
