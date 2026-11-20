// A small in-memory rate limiter for the public share endpoints. Keys live only in this process: nothing is written to disk, and a restart forgets them.
export interface Rule { windowMs: number; max: number }
const MAX_KEYS = 20000;

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
  private prune(now: number, longest: number) {
    for (const [key, list] of this.hits) if (!list.some(at => at > now - longest)) this.hits.delete(key);
    if (this.hits.size > MAX_KEYS) this.hits.clear(); // a flood of distinct keys: forget rather than grow
  }
}

// The caller's address, for rate limiting only. It is never stored or logged. Behind a proxy the first X-Forwarded-For hop is used.
export interface ServerLike { requestIP?: (request: Request) => { address: string } | null }
export function clientKey(request: Request, server?: ServerLike): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  try { return server?.requestIP?.(request)?.address ?? 'unknown'; } catch { return 'unknown'; }
}
