// Which Host names the inbox and the proxy answer to. A page on another site can make a browser send requests to 127.0.0.1 under its own name
// (DNS rebinding); refusing every Host we do not expect closes that. Share links, and the exact one-time secret routes, are credential-protected
// and exempt, because they are meant to be opened from anywhere, by whatever name the server is reached under. A prefix would also let a
// dot-segment through once the URL parser has normalised it, so the secret exemption is the same shapes the remote listener allows.
const SHARE_LINK = /^\/__feedback\/s\//;
const SECRET_PAGE = /^\/__feedback\/x\/[A-Za-z0-9_-]{43}$/;
const SECRET_OPEN = /^\/__feedback\/x\/[A-Za-z0-9_-]{43}\/open$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// A Host header as a name and whether it is an IP literal: "name", "name:port", "1.2.3.4:port" or a bracketed "[::1]:port". Anything else (a comma list,
// spaces, a port that is not a number, an IPv6 address without brackets) is not a host at all.
export function parseHost(header: string | null | undefined): { name: string; ip: boolean } | null {
  const h = (header ?? '').trim().toLowerCase();
  const v6 = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(h);
  if (v6) return v6[1]!.includes(':') ? { name: v6[1]!, ip: true } : null;
  const m = /^([a-z0-9]([a-z0-9._-]*[a-z0-9])?)(?::\d{1,5})?$/.exec(h);
  return m ? { name: m[1]!, ip: IPV4.test(m[1]!) } : null;
}
export const hostName = (header: string | null | undefined): string => parseHost(header)?.name ?? '';
export function allowedNames(env: Record<string, string | undefined> = process.env): string[] {
  const own = hostName(env.FEEDBACK_HOST);
  return [...(own ? [own] : []), ...(env.FEEDBACK_ALLOWED_HOSTS ?? '').split(',').map(x => hostName(x)).filter(Boolean)];
}
// Requests the remote listener (remote.ts) has already checked against its own Host rules and a device cookie: the local guard lets exactly those objects through.
const checked = new WeakSet<Request>();
export const markHostChecked = (req: Request) => { checked.add(req); };
export const hostChecked = (req: Request) => checked.has(req);
// The host of a URL such as FEEDBACK_PUBLIC_URL, as a Host header names it.
export const hostOfUrl = (url: string | null | undefined): string => { try { return url ? hostName(new URL(url).host) : ''; } catch { return ''; } };
// Never throws: a header that cannot be read is a refusal.
export function hostAllowed(req: Request, env: Record<string, string | undefined> = process.env): boolean {
  try {
    const path = new URL(req.url).pathname;
    if (SHARE_LINK.test(path)) return true;
    if ((req.method === 'GET' || req.method === 'HEAD') && SECRET_PAGE.test(path)) return true;
    if (req.method === 'POST' && SECRET_OPEN.test(path)) return true;
    const host = parseHost(req.headers.get('host') ?? new URL(req.url).host); // no Host header (HTTP/1.0): the address the server saw
    if (!host) return false;
    if (host.ip || host.name === 'localhost' || host.name.endsWith('.localhost')) return true;
    return allowedNames(env).includes(host.name);
  } catch { return false; }
}
export const hostRefusal = () => new Response('Host not allowed. Add the name you reach this server by (a custom domain, a tunnel host, a Docker service name) to FEEDBACK_ALLOWED_HOSTS, a comma-separated list.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
export const describeHosts = (env: Record<string, string | undefined> = process.env) =>
  `localhost, *.localhost, IP addresses${allowedNames(env).length ? `, ${allowedNames(env).join(', ')}` : ''} (more: FEEDBACK_ALLOWED_HOSTS)`;
