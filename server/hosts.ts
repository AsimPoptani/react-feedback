// Which Host names the inbox and the proxy answer to. A page on another site can make a browser send requests to 127.0.0.1 under its own name
// (DNS rebinding); refusing every Host we do not expect closes that. Share links are token-protected and exempt, because they are meant to be opened
// from anywhere, by whatever name the server is reached under.
const SHARE = /^\/__feedback\/s\//;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// "name:port", "[::1]:port" or "[::1]" to the lower-cased name (without brackets or port).
export function hostName(header: string | null | undefined): string {
  const h = (header ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') < 0 ? undefined : h.indexOf(']'));
  return h.replace(/:\d*$/, '');
}
export function allowedNames(env: Record<string, string | undefined> = process.env): string[] {
  const own = hostName(env.FEEDBACK_HOST);
  return [...(own ? [own] : []), ...(env.FEEDBACK_ALLOWED_HOSTS ?? '').split(',').map(x => hostName(x)).filter(Boolean)];
}
export function hostAllowed(req: Request, env: Record<string, string | undefined> = process.env): boolean {
  if (SHARE.test(new URL(req.url).pathname)) return true;
  const name = hostName(req.headers.get('host'));
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost') || IPV4.test(name) || name.includes(':')) return true; // an IP literal, v4 or v6
  return allowedNames(env).includes(name);
}
export const hostRefusal = () => new Response('Host not allowed. Add the name you reach this server by (a custom domain, a tunnel host, a Docker service name) to FEEDBACK_ALLOWED_HOSTS, a comma-separated list.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
export const describeHosts = (env: Record<string, string | undefined> = process.env) =>
  `localhost, *.localhost, IP addresses${allowedNames(env).length ? `, ${allowedNames(env).join(', ')}` : ''} (more: FEEDBACK_ALLOWED_HOSTS)`;
