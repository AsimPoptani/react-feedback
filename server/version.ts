// The version this process is: package.json, read once. The inbox compares it with the copy the page loaded.
import { readFileSync } from 'node:fs';

const PLAIN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,40}$/;
let cached: string | undefined;

export function packageVersion(): string {
  if (cached) return cached;
  const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (!PLAIN.test(version)) throw new Error('package.json version is missing or not a plain version');
  cached = version;
  return version;
}
