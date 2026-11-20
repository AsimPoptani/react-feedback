// Remote mode: a second listener, on 127.0.0.1 only, for a tunnel or reverse proxy to point at.
// Behind a tunnel EVERY request arrives from loopback, so loopback is never trusted here. Each request needs the device cookie, except exactly these:
//   - the share routes (GET /__feedback/s/<token>, POST /__feedback/s/<token>/feedback|replay): the token is their credential;
//   - POST /__feedback/api/pair/exchange: it is how a device gets its cookie;
//   - GET /__feedback/inbox/ (and its redirect), which then is a small pairing page and not the inbox.
// The local listener is the ordinary handler and is not touched by any of this.
import { randomBytes } from 'node:crypto';
import { devNull } from 'node:os';
import { Invalid } from './store';
import { Limiter, clientKey, type ServerLike } from './limits';
import { CODE_SHAPE, COOKIE_NAME, DEVICE_TTL_MS, deviceName, pairingFor, type Pairing } from './pair';
import { remoteRequests } from './pair-routes';

type Fetch = (req: Request, server?: ServerLike) => Promise<Response>;
const PREFIX = '/__feedback';
const SHARE_TOKEN = '[A-Za-z0-9_-]{20,64}';
const SHARE_PAGE = new RegExp(`^/__feedback/s/${SHARE_TOKEN}$`);
const SHARE_SEND = new RegExp(`^/__feedback/s/${SHARE_TOKEN}/(feedback|replay)$`);
const EXCHANGE = `${PREFIX}/api/pair/exchange`;
const ME = `${PREFIX}/api/pair/me`;
const SAFE = new Set(['GET', 'HEAD']);
const BODY_TYPES = new Set(['application/json', 'application/octet-stream']); // the two a page cannot send cross-site without a preflight the server never answers
const MAX_EXCHANGE_BODY = 1024;

const noStore = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...noStore, ...headers } });

// The cookie. Secure, so a browser only sends it over https (or to localhost); Strict, so another site's page never gets it sent; HttpOnly, so no script reads it.
export const deviceCookie = (token: string) => `${COOKIE_NAME}=${token}; Max-Age=${DEVICE_TTL_MS / 1000}; Path=${PREFIX}/; HttpOnly; Secure; SameSite=Strict`;
export const clearCookie = () => `${COOKIE_NAME}=; Max-Age=0; Path=${PREFIX}/; HttpOnly; Secure; SameSite=Strict`;
function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE_NAME) return part.slice(at + 1).trim();
  }
  return null;
}

export const isShareRoute = (path: string, method: string) => (method === 'GET' && SHARE_PAGE.test(path)) || (method === 'POST' && SHARE_SEND.test(path));

// The page an unpaired browser is given at the inbox address. It reads the code from the URL fragment (which a browser never sends), wipes the fragment, sends the code once, and
// goes on to the thread named in `to`. Everything is inline under a nonce, so it needs no other file from the server.
export function pairPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>Pair this device</title>
<style nonce="${nonce}">
:root { --paper: #f3f7f5; --ink: #192f38; --ink-2: #40565f; --teal: #00796f; --berry: #b02f62; }
@media (prefers-color-scheme: dark) { :root { --paper: #12212a; --ink: #eef6f3; --ink-2: #b4c9c4; --teal: #75dfce; --berry: #ff8fb7; } }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--paper); color: var(--ink); display: grid; min-height: 100dvh; place-items: center; }
main { max-width: 420px; padding: 24px 16px; }
h1 { font-size: 22px; margin: 0 0 8px; }
p { margin: 8px 0; color: var(--ink-2); }
p.error { color: var(--berry); font-weight: 700; }
button { font: inherit; min-height: 44px; padding: 6px 16px; border: 2px solid var(--ink); border-radius: 10px; background: transparent; color: var(--ink); }
</style></head>
<body><main>
<h1 id="h">This inbox is private</h1>
<p id="msg">To use it on this device, open the link from the QR code in your desktop inbox (choose Open on phone).</p>
<button type="button" id="retry" hidden>Try again</button>
</main>
<script nonce="${nonce}">
(function () {
  var h = document.getElementById('h'), msg = document.getElementById('msg'), retry = document.getElementById('retry');
  var inbox = location.pathname;
  var m = /^#\\/pair\\/([A-Za-z0-9_-]{22})(?:\\?(.*))?$/.exec(location.hash);
  function fail(text) { h.textContent = 'Could not pair this device'; msg.textContent = text; msg.className = 'error'; retry.hidden = true; }
  if (m) {
    var code = m[1], q = new URLSearchParams(m[2] || ''), to = q.get('to') || '', project = q.get('project') || '';
    history.replaceState(null, '', inbox + location.search); // the fragment is gone before anything is sent
    h.textContent = 'Pairing this device'; msg.textContent = 'One moment.';
    fetch('${EXCHANGE}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code: code }) })
      .then(function (r) {
        if (!r.ok) { fail(r.status === 429 ? 'Too many tries. Wait a minute, then scan a new code.' : 'This link has expired or was already used. Scan a new QR code on your desktop.'); return; }
        try { if (/^[\\w-]{1,64}$/.test(project)) localStorage.setItem('fb-inbox-project', project); } catch (e) { /* storage may be blocked */ }
        history.replaceState(null, '', inbox + (/^[\\w-]{1,64}$/.test(to) ? '#/' + to : '#/')); location.reload(); // the same page address with a different fragment: reload, now with the cookie
      })
      .catch(function () { fail('The server could not be reached. Check the connection and scan again.'); });
  } else {
    // Maybe this browser is already paired but the cookie was not sent (a link from another app is a cross-site navigation). A request from this page carries it.
    fetch('${ME}', { credentials: 'same-origin' }).then(function (r) { if (r.ok) location.reload(); else retry.hidden = false; }).catch(function () { retry.hidden = false; });
    retry.addEventListener('click', function () { location.reload(); });
  }
})();
</script></body></html>
`;
}
const pairResponse = (head: boolean) => {
  const nonce = randomBytes(16).toString('base64url');
  return new Response(head ? null : pairPage(nonce), { headers: { ...noStore, 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } });
};

export interface RemoteOptions {
  now?: () => number;
  // The address the phone uses (FEEDBACK_PUBLIC_URL or the tunnel's), read at each request because a tunnel's arrives after start. Unset: the Host header decides.
  publicUrl?: () => string | null;
  clientIpHeader?: string;
}
export interface Remote { fetch: Fetch; pairing: Pairing }

export function createRemoteHandler(inner: Fetch, pairing: Pairing, options: RemoteOptions = {}): Fetch {
  const exchangeLimit = new Limiter([{ windowMs: 60e3, max: 5 }, { windowMs: 3600e3, max: 20 }]);
  const clock = () => options.now?.() ?? Date.now();
  // A write must come from the public address. Without a configured one, the Origin host must be the host the request was sent to.
  function originOk(req: Request): boolean {
    const origin = req.headers.get('origin');
    if (!origin || origin === 'null') return false;
    try {
      const configured = options.publicUrl?.();
      return configured ? new URL(origin).origin === new URL(configured).origin : new URL(origin).host === req.headers.get('host');
    } catch { return false; }
  }
  const unpaired = (stale: boolean) => reply({ kind: 'unpaired', detail: 'This device is not paired. Scan a new QR code from the desktop inbox.' }, 401, stale ? { 'Set-Cookie': clearCookie(), 'Clear-Site-Data': '"cache", "storage"' } : {}); // a revoked phone drops what it kept

  // Read a small body with a hard cap: a declared length over the cap is refused unread, and a stream is cut off at the cap.
  async function smallBody(req: Request): Promise<string | null> {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_EXCHANGE_BODY) return null;
    const reader = req.body?.getReader();
    if (!reader) return '';
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_EXCHANGE_BODY) { await reader.cancel(); return null; }
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  }
  async function exchange(req: Request, server?: ServerLike): Promise<Response> {
    const now = clock();
    if (!originOk(req)) return reply({ kind: 'forbidden', detail: 'Cross-site request refused' }, 403);
    if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return reply({ kind: 'invalid_request', detail: 'JSON only' }, 415);
    const text = await smallBody(req);
    if (text === null) return reply({ kind: 'too_large' }, 413);
    let code: unknown = null;
    try { code = (JSON.parse(text) as { code?: unknown }).code; } catch { /* the same answer as any other bad code */ }
    const invalid = () => reply({ kind: 'invalid_code', detail: 'This link has expired or was already used. Scan a new QR code.' }, 401);
    // Only a well-formed attempt from the right origin counts against the limit, so junk from anywhere cannot use up the one bucket every caller shares behind a tunnel.
    if (typeof code !== 'string' || !CODE_SHAPE.test(code)) return invalid();
    if (!exchangeLimit.take(clientKey(req, server, options.clientIpHeader), now)) return reply({ kind: 'rate_limited' }, 429, { 'Retry-After': '60' });
    // Bad, expired, used and malformed codes all answer the same.
    if (!pairing.redeem(code, now)) return invalid();
    const { token, device } = await pairing.create(deviceName(req.headers.get('user-agent')), now);
    return reply({ ok: true, device: { id: device.id, name: device.name } }, 200, { 'Set-Cookie': deviceCookie(token) });
  }

  const handle: Fetch = async (req, server) => {
    const path = new URL(req.url).pathname, method = req.method;
    if (isShareRoute(path, method)) return inner(req, server);
    if (path === EXCHANGE && method === 'POST') return exchange(req, server);

    const token = cookieOf(req);
    const auth = await pairing.authenticate(token, clock());
    if (!auth) {
      if (path === `${PREFIX}/inbox` && SAFE.has(method)) return new Response(null, { status: 308, headers: { ...noStore, Location: `${PREFIX}/inbox/` } });
      if (path === `${PREFIX}/inbox/` && SAFE.has(method)) return pairResponse(method === 'HEAD');
      return unpaired(token !== null);
    }
    if (!SAFE.has(method)) {
      if (!originOk(req)) return reply({ kind: 'forbidden', detail: 'Cross-site request refused' }, 403);
      const type = req.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (req.body && req.headers.get('content-length') !== '0' && !BODY_TYPES.has(type)) return reply({ kind: 'invalid_request', detail: 'JSON only' }, 415);
    }
    if (path === ME && method === 'GET') return reply({ device: { id: auth.device.id, name: auth.device.name } });

    let request = req;
    if (path.startsWith(`${PREFIX}/api/pair/`) || path.startsWith(`${PREFIX}/api/devices`)) {
      request = new Request(req);
      remoteRequests.set(request, { device: auth.device.id });
    }
    const response = await inner(request, server);
    const out = new Response(response.body, response);
    if (auth.renewed && token) out.headers.append('Set-Cookie', deviceCookie(token)); // the sliding 30 days
    else if (request !== req && !SAFE.has(method) && !(await pairing.authenticate(token, clock()))) out.headers.append('Set-Cookie', clearCookie()); // this device revoked itself
    return out;
  };
  // No stack or detail ever reaches the other side of a tunnel.
  return async (req, server) => {
    try { return await handle(req, server); } catch (error) { console.error('Remote handler error', error instanceof Error ? error.message : 'unknown'); return reply({ kind: 'server_error' }, 500); }
  };
}

// ---- Settings and the tunnel
// FEEDBACK_PUBLIC_URL: the address the phone will use. An origin only (a path is dropped); https, unless it is this machine (http is fine for localhost).
export function loadPublicUrl(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.FEEDBACK_PUBLIC_URL?.trim();
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Invalid('FEEDBACK_PUBLIC_URL must be a full URL, for example https://feedback.example.com'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Invalid('FEEDBACK_PUBLIC_URL must be https (the device cookie is Secure)');
  return url.origin;
}
export function loadRemotePort(env: Record<string, string | undefined> = process.env, localPort = Number(env.PORT ?? 8099)): number {
  const value = env.FEEDBACK_REMOTE_PORT?.trim();
  const port = value ? Number(value) : localPort + 1;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (value && !/^\d+$/.test(value))) throw new Invalid('FEEDBACK_REMOTE_PORT must be a port number from 1 to 65535');
  if (port === localPort) throw new Invalid('FEEDBACK_REMOTE_PORT must differ from PORT');
  return port;
}
export const remoteWanted = (args: string[], env: Record<string, string | undefined> = process.env) => args.includes('--remote') || /^(1|on|true|yes)$/i.test(env.FEEDBACK_REMOTE?.trim() ?? '');

// cloudflared prints the address of a quick tunnel in a box of log lines. A log line may carry other links (documentation, terms), so the address is the first one after the
// "created" line, or failing that the first whose first label looks like a generated name (several words joined by hyphens).
export function findTunnelUrl(text: string): string | null {
  const urls = (line: string) => [...line.matchAll(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map(m => ({ url: m[0], host: m[1]! }));
  let afterCreated = false;
  for (const line of text.split(/\r?\n/)) {
    if (/tunnel has been created/i.test(line)) afterCreated = true;
    for (const { url, host } of urls(line)) {
      if (/^(www|api|developers|dash|community)\./i.test(host)) continue;
      if (afterCreated || /^[a-z0-9]+(?:-[a-z0-9]+){2,}\./i.test(host)) return url;
    }
  }
  return null;
}
export interface Tunnel { url: string; stop: () => void }
export async function startTunnel(port: number, env: Record<string, string | undefined> = process.env, timeoutMs = 30000, onExit: (code: number | null) => void = () => {}): Promise<Tunnel | null> {
  const bin = Bun.which('cloudflared', env.PATH ? { PATH: env.PATH } : {});
  if (!bin) return null;
  // An empty config file, so a config.yml in the user's cloudflared folder cannot change what a quick tunnel is.
  const child = Bun.spawn([bin, 'tunnel', '--config', devNull, '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const stop = () => { try { child.kill(); } catch { /* already gone */ } };
  for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stop(); if (signal !== 'exit') process.exit(0); });
  let seen = '', found = false;
  const url = await new Promise<string | null>(done => {
    const timer = setTimeout(() => done(null), timeoutMs);
    // Both pipes are read until they close, after the address is found too: a child whose pipe nobody reads dies on its next log line.
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        if (found) continue;
        seen += decoder.decode(chunk, { stream: true });
        const address = findTunnelUrl(seen);
        if (address) { found = true; seen = ''; clearTimeout(timer); done(address); }
      }
    };
    void drain(child.stdout).catch(() => undefined); void drain(child.stderr).catch(() => undefined);
    void child.exited.then(code => { clearTimeout(timer); done(null); if (found) onExit(code); });
  });
  if (!url) { stop(); return null; }
  return { url, stop };
}

// Start the remote listener beside the local one. `local` is what serverOptions returned. Returns what the caller needs to print and to stop.
export async function startRemote(local: { fetch: Fetch; maxRequestBodySize: number; port: number }, dir: string, env: Record<string, string | undefined> = process.env, log: (line: string) => void = console.log) {
  const port = loadRemotePort(env, local.port);
  const configured = loadPublicUrl(env);
  const pairing = pairingFor(dir);
  const state = { publicUrl: configured };
  pairing.remote = { on: true, publicUrl: configured, source: configured ? 'env' : null };
  let tunnel: Tunnel | null = null;
  const fromTunnel = !configured && Bun.which('cloudflared', env.PATH ? { PATH: env.PATH } : {}) !== null;
  const handler = createRemoteHandler(local.fetch, pairing, { publicUrl: () => state.publicUrl, ...(fromTunnel && !env.FEEDBACK_CLIENT_IP_HEADER?.trim() ? { clientIpHeader: 'cf-connecting-ip' } : {}) });
  const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: local.maxRequestBodySize, fetch: handler });
  const bound = server.port ?? port;
  log(`Remote mode: listening on http://127.0.0.1:${bound} (every request needs a paired device)`);
  if (configured && !env.FEEDBACK_CLIENT_IP_HEADER?.trim()) log('Warning: FEEDBACK_CLIENT_IP_HEADER is not set, so every caller through your proxy shares one pairing rate limit. Set it to the header your proxy sets (for Cloudflare, Cf-Connecting-Ip).');
  if (configured) log(`Public address: ${configured} (FEEDBACK_PUBLIC_URL). Point your proxy or tunnel at 127.0.0.1:${bound}.`);
  else if (fromTunnel) {
    log('Starting a quick tunnel with cloudflared...');
    tunnel = await startTunnel(bound, env, 30000, code => log(`The tunnel stopped (cloudflared exited with ${code}). Phones can no longer reach this server until you restart it.`));
    if (tunnel) { state.publicUrl = tunnel.url; pairing.remote = { on: true, publicUrl: tunnel.url, source: 'tunnel' }; log(`Public address: ${tunnel.url} (a quick tunnel; it changes each time you start it)`); }
    else log('The tunnel did not start. Set FEEDBACK_PUBLIC_URL and point your own proxy or tunnel at the remote port.');
  } else {
    log(`No public address yet. Either install cloudflared (a quick tunnel then starts by itself), or set FEEDBACK_PUBLIC_URL (https) and point your own tunnel or proxy at 127.0.0.1:${bound}.`);
  }
  if (state.publicUrl) log('Open the inbox on this computer, choose "Open on phone", and scan the QR code.');
  return { server, port: bound, tunnel, stop: () => { tunnel?.stop(); void server.stop(true); } };
}
