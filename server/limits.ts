// A small in-memory rate limiter for the public share endpoints. Keys live only in this process: nothing is written to disk, and a restart forgets them.
export interface Rule { windowMs: number; max: number }
export const MAX_KEYS = 20000;

export class Limiter {
  private hits = new Map<string, number[]>();
  constructor(private rules: Rule[]) {}
  // True when the call is allowed (and counted); false when any rule is already full.
  take(key: string, now: number): boolean {
    const longest = Math.max(...this.rules.map(rule => rule.windowMs));
    const seen = (this.hits.get(key) ?? []).filter(at => at > now - longest);
    for (const rule of this.rules) if (seen.filter(at => at > now - rule.windowMs).length >= rule.max) { this.hits.set(key, seen); return false; }
    seen.push(now);
    this.hits.set(key, seen);
    if (this.hits.size > MAX_KEYS) this.prune(now, longest);
    return true;
  }
  // Over the cap: drop keys with no recent hits first, then the oldest-seen keys, just enough to get back under. Never clear everyone's counters.
  private prune(now: number, longest: number) {
    for (const [key, list] of this.hits) if (!list.some(at => at > now - longest)) this.hits.delete(key);
    if (this.hits.size <= MAX_KEYS) return;
    const excess = this.hits.size - MAX_KEYS;
    let dropped = 0;
    for (const key of this.hits.keys()) { if (dropped++ >= excess) break; this.hits.delete(key); } // a Map keeps insertion order: the stalest first
  }
  get size() { return this.hits.size; }
}

// A byte budget per key over a window (screenshots a link may receive a day). In memory only, like the rest.
export class ByteBudget {
  private spent = new Map<string, [number, number][]>();
  constructor(private max: number, private windowMs: number) {}
  // True when `bytes` fit in what is left (and counts them); false when they would not. A single amount over the whole budget never fits.
  take(key: string, bytes: number, now: number): boolean {
    const seen = (this.spent.get(key) ?? []).filter(([at]) => at > now - this.windowMs);
    const total = seen.reduce((sum, [, n]) => sum + n, 0);
    if (total + bytes > this.max) { this.spent.set(key, seen); return false; }
    seen.push([now, bytes]);
    this.spent.set(key, seen);
    if (this.spent.size > MAX_KEYS) for (const [k, list] of this.spent) { if (!list.some(([at]) => at > now - this.windowMs)) this.spent.delete(k); if (this.spent.size <= MAX_KEYS) break; }
    return true;
  }
  // Gives back what take() counted, when the thing it was for did not happen.
  release(key: string, bytes: number): void {
    const list = this.spent.get(key); if (!list) return;
    const at = list.findLastIndex(([, n]) => n === bytes);
    if (at >= 0) list.splice(at, 1);
  }
  get size() { return this.spent.size; }
}

// The caller's address, for rate limiting only. It is never stored or logged. By default it is the socket address. A forwarded header is believed only when the
// operator names the one header their proxy sets (FEEDBACK_CLIENT_IP_HEADER, e.g. cf-connecting-ip behind a Cloudflare tunnel): X-Forwarded-For is never used,
// because a client can write its first hop.
export interface ServerLike { requestIP?: (request: Request) => { address: string } | null }
export function clientKey(request: Request, server?: ServerLike, header: string | undefined = process.env.FEEDBACK_CLIENT_IP_HEADER): string {
  const name = header?.trim().toLowerCase();
  if (name && /^[a-z0-9-]{1,64}$/.test(name)) {
    const value = request.headers.get(name)?.split(',').pop()?.trim();
    if (value) return value.slice(0, 64);
  }
  try { return server?.requestIP?.(request)?.address ?? 'unknown'; } catch { return 'unknown'; }
}

// The remote listener chooses the client-IP header for a request (a quick tunnel uses cf-connecting-ip). Secret opens read it here.
// Without this, every opener behind that tunnel shares the loopback socket address and one rate-limit bucket.
const markedIp = new WeakMap<Request, string>();
export const markClientIpHeader = (request: Request, header: string) => { markedIp.set(request, header); };
export const markedClientIpHeader = (request: Request): string | undefined => markedIp.get(request);
