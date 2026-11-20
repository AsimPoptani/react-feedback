// The page a secret link serves. It is package HTML only: no inbox script, no inbox style, no request until Reveal is pressed.
// The key stays in the URL fragment until a reveal that is not rate-limited, then the page wipes the fragment. A 429 leaves it so Reveal can be pressed again. The fragment is never sent.
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

const SCRIPT = String.raw`(function () {
  var reveal = document.getElementById('reveal');
  var msg = document.getElementById('msg');
  var secret = document.getElementById('secret');
  var copy = document.getElementById('copy');
  var GONE = 'This link has expired or was already used';
  function show(text) {
    reveal.hidden = true; secret.hidden = true; copy.hidden = true;
    msg.hidden = false; msg.textContent = text;
  }
  function b64ToBytes(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64urlToBytes(s) {
    var pad = s.length % 4 === 0 ? '' : '===='.slice(s.length % 4);
    return b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  }
  function wipe() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the fragment is still local */ }
  }
  function legacyCopy(text) {
    try {
      var box = document.createElement('textarea');
      box.value = text; box.setAttribute('readonly', '');
      box.setAttribute('spellcheck', 'false'); box.setAttribute('autocomplete', 'off'); box.setAttribute('autocapitalize', 'off'); box.setAttribute('autocorrect', 'off');
      box.setAttribute('data-gramm', 'false'); box.setAttribute('data-enable-grammarly', 'false'); box.setAttribute('data-lpignore', 'true'); box.setAttribute('data-1p-ignore', 'true'); box.setAttribute('data-bwignore', 'true');
      box.style.position = 'fixed'; box.style.opacity = '0';
      document.body.appendChild(box); box.select();
      var ok = document.execCommand('copy'); box.remove(); return !!ok;
    } catch (e) { return false; }
  }
  function unpad(bytes) {
    if (!bytes || bytes.length < 64 || bytes.length % 64 !== 0 || bytes[0] !== 1) return bytes;
    var len = ((bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    if (len > bytes.length - 4) return bytes;
    for (var i = 4 + len; i < bytes.length; i++) if (bytes[i] !== 0) return bytes;
    return bytes.subarray(4, 4 + len);
  }
  reveal.addEventListener('click', function () {
    if (reveal.disabled) return;
    reveal.disabled = true;
    var hash = location.hash.charAt(0) === '#' ? location.hash.slice(1) : location.hash;
    var path = location.pathname, m = /^\/__feedback\/x\/([A-Za-z0-9_-]{43})$/.exec(path);
    var keyBytes = null;
    try { keyBytes = hash ? b64urlToBytes(decodeURIComponent(hash)) : null; } catch (e) { keyBytes = null; }
    if (!m || !keyBytes || keyBytes.length !== 32 || !crypto.subtle) { wipe(); if (keyBytes) keyBytes.fill(0); show(GONE); return; }
    fetch(path + '/open', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }, function () { return { ok: false, status: r.status, data: null }; }); })
      .then(function (res) {
        if (res.status === 429) {
          reveal.disabled = false;
          msg.hidden = false;
          msg.textContent = 'Too many tries, wait a minute and press Reveal again';
          return;
        }
        wipe();
        if (!res.ok || !res.data || typeof res.data.ciphertext !== 'string' || typeof res.data.iv !== 'string') { show(GONE); return; }
        var iv = b64ToBytes(res.data.iv), cipher = b64ToBytes(res.data.ciphertext);
        return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']).then(function (key) {
          return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, cipher);
        }).then(function (plain) {
          secret.textContent = new TextDecoder().decode(unpad(new Uint8Array(plain)));
          secret.hidden = false; copy.hidden = false; reveal.hidden = true; msg.hidden = true;
        });
      })
      .catch(function () { wipe(); show(GONE); })
      .then(function () { if (keyBytes) keyBytes.fill(0); });
  });
  copy.addEventListener('click', function () {
    var text = secret.textContent || '';
    var done = function (ok) { copy.textContent = ok ? 'Copied' : 'Copy failed'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacyCopy(text)); });
    else done(legacyCopy(text));
  });
  window.addEventListener('pagehide', function () { secret.textContent = ''; });
})();
`;

export function secretPage(nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error('bad nonce');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>Secret</title>
<style nonce="${nonce}">
:root { --paper: #f3f7f5; --ink: #192f38; --ink-2: #40565f; --teal: #00796f; }
@media (prefers-color-scheme: dark) { :root { --paper: #12212a; --ink: #eef6f3; --ink-2: #b4c9c4; --teal: #75dfce; } }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--paper); color: var(--ink); }
main { max-width: 36rem; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 8px; }
p { margin: 8px 0; color: var(--ink-2); }
#secret { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); background: transparent; border: 2px solid var(--ink); border-radius: 10px; padding: 12px; margin: 12px 0; }
button { font: inherit; min-height: 44px; padding: 6px 16px; border: 2px solid var(--ink); border-radius: 10px; background: var(--teal); color: var(--paper); font-weight: 700; }
p.error { color: var(--ink); font-weight: 700; }
</style></head>
<body><main>
<h1>A secret was shared with you</h1>
<p>Nothing is sent until you choose Reveal. The link stops working after that.</p>
<button type="button" id="reveal">Reveal</button>
<p id="msg" class="error" role="alert" hidden></p>
<div id="secret" data-rf-private hidden spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" data-gramm="false" data-enable-grammarly="false" data-lpignore="true" data-1p-ignore="true" data-bwignore="true"></div>
<button type="button" id="copy" hidden>Copy</button>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>
`;
}
