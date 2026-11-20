// The page a share link serves: a small trusted shell around the artifact. The artifact sits in a sandboxed iframe (opaque origin, no access to
// this page), and this page adds a Feedback button and, when the owner has switched it on, the recording notice. Package code only: it makes
// no inbox API calls and carries no inbox chrome. The shell is itself sandboxed by the response header (no allow-same-origin).
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseShot } from './inbox/shot.js';

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Code inside a <script> element must not contain the end tag or an HTML comment opener.
const safeScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

let recorderCode: string | null | undefined;
async function recorderBundle(): Promise<string | null> {
  if (recorderCode !== undefined) return recorderCode;
  try { recorderCode = await readFile(resolve(import.meta.dir, '../dist/recorder.js'), 'utf8'); }
  catch { recorderCode = null; } // not built: the page is served without it, and without the notice
  return recorderCode;
}

// The widget's own capture (region, element, section, full page, with a screenshot and drawing), built to dist/capture.js. It runs inside the artifact, where the page is,
// does nothing until the page that framed it asks, and hands the finished capture back by postMessage. It makes no request of its own.
let captureCode: string | null | undefined;
async function captureBundle(): Promise<string | null> {
  if (captureCode !== undefined) return captureCode;
  try { captureCode = await readFile(resolve(import.meta.dir, '../dist/capture.js'), 'utf8'); }
  catch { captureCode = null; } // not built: the page is served without it, and without the capture buttons
  return captureCode;
}
// The owner's own view of an artifact in the inbox: the same capture script, and nothing else is added to the page.
export async function withCapture(html: string): Promise<string> {
  const code = await captureBundle();
  return code === null ? html : inject(html, `<script>${safeScript(code)}</script>`);
}

// Runs inside the artifact. It can only talk to the page that framed it, by postMessage. "Pointing" reports what was clicked: a text snippet, a CSS path
// and a viewport-relative box. Anything inside [data-rf-private] reports no text.
const HELPER = `(function () {
  var pointing = false, last = null;
  function path(node) {
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\\w-]{0,40}$/.test(node.id)) { parts.unshift(part + '#' + node.id); break; }
      var same = 0, index = 0, sib = node.parentNode ? node.parentNode.children : [];
      for (var i = 0; i < sib.length; i++) { if (sib[i].tagName === node.tagName) { same++; if (sib[i] === node) index = same; } }
      if (same > 1) part += ':nth-of-type(' + index + ')';
      parts.unshift(part);
      node = node.parentNode;
    }
    return parts.join(' > ').slice(0, 300);
  }
  function clear() { if (last) { last.style.outline = last.__rfOutline || ''; last = null; } }
  function over(event) {
    if (!pointing) return;
    clear();
    last = event.target;
    if (last && last.style) { last.__rfOutline = last.style.outline; last.style.outline = '2px solid #00796f'; }
  }
  function click(event) {
    if (!pointing) return;
    event.preventDefault(); event.stopPropagation();
    var node = event.target, rect = node.getBoundingClientRect();
    var text = node.closest && node.closest('[data-rf-private]') ? '' : String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
    var box = [rect.left / innerWidth, rect.top / innerHeight, rect.width / innerWidth, rect.height / innerHeight];
    stop();
    parent.postMessage({ rf: 'pick', text: text, path: path(node), box: box }, '*');
  }
  function stop() { pointing = false; clear(); document.documentElement.style.cursor = ''; }
  document.addEventListener('mouseover', over, true);
  document.addEventListener('click', click, true);
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.rf !== 'point') return;
    if (data.on) { pointing = true; document.documentElement.style.cursor = 'crosshair'; } else stop();
  });
})();`;

// Runs inside the artifact when recording is on. It records nothing until the shell sends "start", and stops the moment the shell says "stop".
const RECORD_GLUE = `(function () {
  var stop = null;
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.rf !== 'ctl' || !window.RFRecorder) return;
    if (data.op === 'start' && !stop) stop = window.RFRecorder.start({ emit: function (e) { parent.postMessage({ rf: 'ev', event: e }, '*'); } });
    if (data.op === 'stop' && stop) { stop(); stop = null; }
  });
  parent.postMessage({ rf: 'ready' }, '*');
})();`;

function inject(html: string, scripts: string): string {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? `${html}\n${scripts}` : `${html.slice(0, at)}${scripts}\n${html.slice(at)}`;
}

const SHELL_STYLE = `
:root { color-scheme: light; --ink: #192f38; --teal: #00796f; --rule: #c3d2cc; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; font: 16px/1.45 system-ui, sans-serif; color: var(--ink); background: #fff; }
body { display: flex; flex-direction: column; }
#notice { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 16px; background: #f3f7f5; border-bottom: 1px solid var(--rule); font-size: 14px; }
#notice[hidden] { display: none; }
#notice p { margin: 0; flex: 1 1 220px; }
button { font: inherit; min-height: 44px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--rule); background: #fff; color: var(--ink); cursor: pointer; }
button.primary { background: var(--teal); border-color: var(--teal); color: #fff; font-weight: 700; }
button:focus-visible, textarea:focus-visible { outline: 3px solid #f5b400; outline-offset: 2px; }
#art { flex: 1 1 0; width: 100%; min-height: 0; border: 0; background: #fff; display: block; }
#fb-open { position: fixed; right: 16px; bottom: 16px; z-index: 5; border-color: var(--teal); color: var(--teal); font-weight: 700; box-shadow: 0 2px 10px rgba(0, 0, 0, .18); }
#fb-hint { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 6; max-width: calc(100vw - 32px); background: var(--ink); color: #fff; border-radius: 10px; padding: 10px 14px; font-size: 14px; display: flex; gap: 10px; align-items: center; }
#fb-hint[hidden] { display: none; }
#fb-toast { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 6; max-width: calc(100vw - 32px); background: var(--ink); color: #fff; border-radius: 10px; padding: 10px 14px; font-size: 14px; }
#fb-toast[hidden], #fb-capture[hidden], #fb-held[hidden], #fb-open[hidden] { display: none; }
#fb-held { margin: 8px 0 0; padding: 8px 10px; border-left: 3px solid var(--teal); background: #f3f7f5; font-size: 14px; }
#fb-hint button { min-height: 36px; padding: 4px 10px; }
dialog { width: min(92vw, 440px); border: 1px solid var(--rule); border-radius: 14px; padding: 16px; color: var(--ink); }
dialog::backdrop { background: rgba(25, 47, 56, .45); }
dialog h2 { margin: 0 0 8px; font-size: 18px; }
dialog label { display: block; font-weight: 700; margin: 8px 0 4px; }
textarea { width: 100%; min-height: 110px; padding: 10px; font: inherit; border: 1px solid var(--rule); border-radius: 10px; resize: vertical; }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
.row .grow { flex: 1 1 auto; }
#fb-quote { margin: 8px 0 0; padding: 8px 10px; border-left: 3px solid var(--teal); background: #f3f7f5; font-size: 14px; overflow-wrap: anywhere; }
#fb-quote[hidden] { display: none; }
#fb-status { min-height: 1.3em; margin: 8px 0 0; font-size: 14px; }
.small { font-size: 13px; color: #4a636d; }
`;

export const SHELL_SCRIPT = `(function () {
  var cfg = JSON.parse(document.getElementById('rf-config').textContent);
  var frame = document.getElementById('art');
  var base = location.pathname.replace(/\\/$/, '');
  var NOREC = '#rf-no-record';
  var declined = location.hash === NOREC;
  var pick = null, recording = false;
  var $ = function (id) { return document.getElementById(id); };
  var say = function (text) { $('fb-status').textContent = text; };
  var post = function (op, body) {
    return fetch(base + '/' + op, { method: 'POST', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain' }, body: body, keepalive: body.length < 60000 });
  };
  var tell = function (message) { try { frame.contentWindow.postMessage(message, '*'); } catch (e) { /* the frame is gone */ } };

  // ---- Feedback
  var dialog = $('fb-dialog'), note = $('fb-note');
  var kept = null; // a capture whose send failed: it stays attached to the note until it goes or is removed
  var toastTimer = 0;
  function toast(text) { var t = $('fb-toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 5000); }
  function drawQuote() {
    $('fb-quote').hidden = !pick;
    $('fb-quote-text').textContent = pick ? (pick.text ? '“' + pick.text + '”' : pick.path) : '';
    $('fb-point').textContent = pick ? 'Point at something else' : 'Point at something on the page';
    $('fb-held').hidden = !kept;
  }
  function openDialog() { say(''); drawQuote(); if (!dialog.open) dialog.showModal(); note.focus(); }
  $('fb-open').addEventListener('click', openDialog);
  $('fb-cancel').addEventListener('click', function () { dialog.close(); });
  $('fb-point').addEventListener('click', function () { dialog.close(); $('fb-hint').hidden = false; tell({ rf: 'point', on: true }); });
  $('fb-hint-cancel').addEventListener('click', function () { $('fb-hint').hidden = true; tell({ rf: 'point', on: false }); openDialog(); });
  $('fb-unpick').addEventListener('click', function () { pick = null; drawQuote(); });
  $('fb-unhold').addEventListener('click', function () { kept = null; drawQuote(); });
  // The note: with a capture still attached it goes with its picture, otherwise as a note alone (the same request as before).
  function bodyOf(shot) {
    var quote = { text: shot.text, path: shot.selector, mode: shot.mode };
    if (shot.box) quote.box = shot.box;
    if (shot.components.length) quote.components = shot.components;
    if (shot.source) quote.source = shot.source;
    var body = { note: shot.note, quote: quote };
    if (shot.image) body.image = shot.image;
    return body;
  }
  function sendNote(body, withImage) {
    return post('feedback' + (withImage ? '?image=1' : ''), JSON.stringify(body)).then(function (r) {
      if (r.status === 201) return { ok: true, text: 'Thanks, your note was sent.' };
      if (r.status === 429) return { ok: false, text: 'Too many notes just now. Try again in a minute.' };
      if (r.status === 404) return { ok: false, text: 'This link is no longer active.' };
      if (r.status === 413) return { ok: false, text: 'That screenshot is too large to send. Remove it and send the note.' };
      return { ok: false, text: 'Could not send that. Try again.' };
    }, function () { return { ok: false, text: 'Could not send that. Check your connection and try again.' }; });
  }
  $('fb-send').addEventListener('click', function () {
    var text = note.value.trim();
    if (!text) { say('Write a note first.'); return; }
    $('fb-send').disabled = true; say('Sending…');
    var shot = kept ? Object.assign({}, kept, { note: text }) : null;
    var body = shot ? bodyOf(shot) : { note: text };
    if (!shot && pick) body.quote = pick;
    sendNote(body, !!(shot && shot.image)).then(function (done) {
      if (done.ok) { note.value = ''; pick = null; kept = null; drawQuote(); say(done.text); } else say(done.text);
    }).then(function () { $('fb-send').disabled = false; });
  });

  // ---- The capture script inside the artifact: region, element, section and full page, with a screenshot. It starts when asked and answers by message.
  var capReady = false, armed = null;
  var MODES = ['region', 'element', 'section', 'page'];
  var SHOT_CHARS = 2900000; // about 2 MB decoded, as base64
  var parseShot = __PARSE_SHOT__;
  MODES.forEach(function (mode) {
    var button = document.querySelector('[data-capture="' + mode + '"]');
    if (!button) return;
    button.addEventListener('click', function () {
      dialog.close(); $('fb-open').hidden = true;
      // The artifact is the page's own code, so a capture counts only when the viewer asked for one here: one arm, a one-time word the capture script must echo, two minutes.
      var rnd = new Uint8Array(12); crypto.getRandomValues(rnd);
      armed = { nonce: Array.prototype.map.call(rnd, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''), until: Date.now() + 120000 };
      tell({ rf: 'cap', op: 'start', mode: mode, note: note.value.slice(0, 4000), maxBytes: 1900000, nonce: armed.nonce });
    });
  });
  function arrived(data) {
    $('fb-open').hidden = false;
    if (!armed || typeof data.nonce !== 'string' || data.nonce !== armed.nonce || Date.now() > armed.until) return; // not asked for: nothing is sent
    armed = null;
    var shot = parseShot(data, SHOT_CHARS);
    if (!shot) { toast('That capture could not be read.'); return; }
    toast('Sending…');
    sendNote(bodyOf(shot), !!shot.image).then(function (done) {
      if (done.ok) { kept = null; note.value = ''; toast(done.text); return; }
      kept = shot; note.value = shot.note; openDialog(); say(done.text);
    });
  }

  // ---- Messages from the artifact. Only its own window is believed.
  var clip = function (value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; };
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.rf === 'pick') {
      var box = Array.isArray(data.box) && data.box.length === 4 && data.box.every(function (n) { return typeof n === 'number' && isFinite(n); }) ? data.box : null;
      pick = { text: clip(data.text, 200), path: clip(data.path, 300), box: box };
      $('fb-hint').hidden = true; openDialog();
    } else if (data.rf === 'cap-ready') {
      capReady = true; $('fb-capture').hidden = false;
    } else if (data.rf === 'cap-closed') {
      $('fb-open').hidden = false;
      if (armed) armed.until = Math.min(armed.until, Date.now() + 20000); // the picture is fitted after the capture closes: a short grace
    } else if (data.rf === 'shot') {
      arrived(data);
    } else if (data.rf === 'ready') {
      if (cfg.record && !declined) { recording = true; tell({ rf: 'ctl', op: 'start' }); }
    } else if (data.rf === 'ev' && recording && data.event && typeof data.event === 'object') {
      push(data.event);
    }
  });

  // ---- Recording: the notice, the opt-out, and the batched upload
  if (cfg.record) {
    $('notice').hidden = false;
    $('norec').addEventListener('click', function () {
      declined = true; recording = false; buffer = []; tell({ rf: 'ctl', op: 'stop' });
      forget();
      try { history.replaceState(null, '', location.pathname + location.search + NOREC); } catch (e) { /* the choice lasts for this page only */ }
      $('notice-text').textContent = 'Not recording. Nothing more from this page is sent, and anything already sent is deleted.'; $('norec').hidden = true;
    });
    if (declined) { $('notice-text').textContent = 'Not recording. Nothing from this page is sent.'; $('norec').hidden = true; }
  }
  var bytes = new Uint8Array(18); crypto.getRandomValues(bytes);
  var session = btoa(String.fromCharCode.apply(null, bytes)).replace(/\\+/g, '-').replace(/\\//g, '_');
  var buffer = [], size = 0, seq = 0, sending = false, stopped = false, inflight = null;
  // Nothing leaves this page for the first HOLD_MS (the notice is up and the choice is open), and the first upload goes out only at the next 4 s tick after that.
  var HOLD_MS = 10000, born = Date.now();
  function held() { return Date.now() - born < HOLD_MS; }
  // "Don't record" also deletes whatever this visit already sent: the server checks the session belongs to this link.
  function forget() {
    var tries = 0;
    function send() {
      post('replay', JSON.stringify({ session: session, discard: true })).then(function (r) { if (r.status === 429 || r.status >= 500) again(); }, again);
    }
    function again() { if (++tries < 4) setTimeout(send, 1500); }
    var go = function () { if (seq > 0 || inflight) send(); };
    (inflight || Promise.resolve()).then(go, go);
  }
  function push(event) { var s = JSON.stringify(event).length; buffer.push(event); size += s; if (size > 300000) flush(); }
  function flush() {
    if (held() || sending || stopped || declined || !buffer.length) return;
    var events = buffer, taken = size; buffer = []; size = 0; sending = true;
    inflight = post('replay', JSON.stringify({ session: session, seq: seq, events: events }));
    inflight.then(function (r) {
      if (r.ok) seq++;
      else if (r.status === 429 || r.status >= 500) { buffer = events.concat(buffer); size += taken; }
      else { stopped = true; recording = false; tell({ rf: 'ctl', op: 'stop' }); } // full, or switched off, or the link has gone
    }, function () { buffer = events.concat(buffer); size += taken; }).then(function () { sending = false; inflight = null; });
  }
  if (cfg.record) {
    setInterval(flush, 4000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', flush);
  }
})();`;

// The shell's script as it is sent: with the function it believes the artifact's capture with filled in.
export const shellScript = () => SHELL_SCRIPT.replace('__PARSE_SHOT__', () => parseShot.toString());

export interface ShellInput { html: string; title: string; record: boolean }
export async function shellPage(input: ShellInput): Promise<string> {
  const bundle = input.record ? await recorderBundle() : null;
  const record = input.record && bundle !== null;
  const capture = await captureBundle();
  const scripts = [`<script>${safeScript(HELPER)}</script>`, ...(capture !== null ? [`<script>${safeScript(capture)}</script>`] : []), ...(record ? [`<script>${safeScript(bundle!)}</script>`, `<script>${safeScript(RECORD_GLUE)}</script>`] : [])].join('\n');
  const doc = inject(input.html, scripts);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeText(input.title || 'Shared page')}</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<div id="notice" role="status" hidden><p id="notice-text">This page records clicks and mouse movement to help the author.</p><button type="button" id="norec">Don't record</button></div>
<iframe id="art" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" title="${escapeAttr(input.title || 'Shared page')}" srcdoc="${escapeAttr(doc)}"></iframe>
<button type="button" id="fb-open">Feedback</button>
<div id="fb-toast" role="status" aria-live="polite" hidden></div>
<div id="fb-hint" hidden role="status"><span>Click the part of the page you mean.</span><button type="button" id="fb-hint-cancel">Cancel</button></div>
<dialog id="fb-dialog" aria-labelledby="fb-h">
  <h2 id="fb-h">Send feedback</h2>
  <label for="fb-note">Your note</label>
  <textarea id="fb-note" maxlength="4000" placeholder="What did you notice?"></textarea>
  <p id="fb-quote" hidden><span class="small">Pointing at</span><br><span id="fb-quote-text"></span> <button type="button" id="fb-unpick" class="small">Remove</button></p>
  <div class="row"><button type="button" id="fb-point">Point at something on the page</button></div>
  <div class="row" id="fb-capture" role="group" aria-label="Capture a screenshot" hidden><span class="small">Or capture</span><button type="button" data-capture="region">Region</button><button type="button" data-capture="element">Element</button><button type="button" data-capture="section">Section</button><button type="button" data-capture="page">Full page</button></div>
  <p id="fb-held" hidden>A screenshot is attached to this note. <button type="button" id="fb-unhold" class="small">Remove</button></p>
  <p id="fb-status" role="status" aria-live="polite"></p>
  <div class="row"><span class="grow small">Only your note, your screenshot and what you point at are sent. No name or address.</span><button type="button" id="fb-cancel">Close</button><button type="button" id="fb-send" class="primary">Send</button></div>
</dialog>
<script type="application/json" id="rf-config">${JSON.stringify({ record })}</script>
<script>${safeScript(shellScript())}</script>
</body>
</html>
`;
}
