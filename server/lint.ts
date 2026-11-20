// Checks on what an agent writes to the person (CLI reply/ask, MCP reply/ask). They never stop a message: the message is sent and the result carries `warnings`.
// The person reads these messages on a phone, between other things: short, plain words, one question at a time, and a recommended answer.
import type { Message } from './store';
import { openQuestions } from './store';

export const MAX_WORDS = 120;
// FEEDBACK_AGENT_LINT=off turns the checks off; anything else (or nothing) is warn.
export const lintOn = (env: Record<string, string | undefined> = process.env): boolean => !/^(off|0|false|no)$/i.test(env.FEEDBACK_AGENT_LINT?.trim() ?? '');

// Words an all-caps token may be without being an internal code.
const ALLOWED_CAPS = new Set(['HTTP', 'HTTPS', 'JSON', 'HTML', 'YAML', 'TOML', 'CSV', 'URL', 'URLS', 'REST', 'HTTP2', 'NULL', 'TRUE', 'FALSE', 'NOTE', 'TODO', 'DONE', 'ASAP', 'FAQ', 'LGTM', 'WIFI', 'USB', 'HTTPS', 'SSL', 'TLS', 'DNS', 'CORS', 'CSS', 'SQL', 'ARIA', 'EOF', 'CRUD', 'UUID', 'UTF', 'ASCII', 'PDF', 'PNG', 'JPEG', 'SVG', 'GIF', 'WEBP', 'MCP', 'CLI', 'NASA']);
const CODE = /\b[A-Z]{1,5}\d+(?:-\w+)?\b/g; // like R1-fix, G7, ABC12
const MSG_ID = /\b[qc]\d+\b/g; // the inbox's own question and checklist ids: q3, c14
const PATH = /(?:^|[\s(`'"])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8})\b/g; // a path with a slash and an extension
const CAPS = /\b[A-Z]{4,}\b/g;

const strip = (text: string) => text.replace(/https?:\/\/\S+/g, ' ').replace(/```[\s\S]*?```/g, ' ');
const wordCount = (text: string) => (text.trim().match(/\S+/g) ?? []).length;

// What looks like an internal code or a file path in the text, without repeats, at most `limit` of them.
export function internalCodes(text: string, limit = 6): string[] {
  const body = strip(text);
  const found = new Set<string>();
  for (const m of body.matchAll(PATH)) found.add(m[1]!);
  for (const m of body.matchAll(CODE)) found.add(m[0]);
  for (const m of body.matchAll(MSG_ID)) found.add(m[0]);
  for (const m of body.matchAll(CAPS)) if (!ALLOWED_CAPS.has(m[0])) found.add(m[0]);
  return [...found].slice(0, limit);
}

// "I'll …" and "I will …": a promise the agent made. Returns the clause (a short one) so the result can suggest a checklist item for it.
const PROMISE = /\bI(?:'|’)ll\s+([^.!?\n;]{3,100})|\bI will\s+([^.!?\n;]{3,100})/gi;
export function promisesIn(text: string, limit = 3): string[] {
  const out: string[] = [];
  for (const m of strip(text).matchAll(PROMISE)) {
    const clause = (m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' ');
    if (clause && !out.includes(clause)) out.push(clause);
    if (out.length >= limit) break;
  }
  return out;
}
export const promiseItem = (clause: string): string => { const text = `I'll ${clause}`; return text.length > 300 ? `${text.slice(0, 299)}…` : text; };

export interface LintInput {
  text: string;
  // For an ask: the options as given, and whether the card has one marked recommended.
  asking?: { options: { recommended?: boolean }[] };
  // The thread's messages before this one, to see whether a question is already open.
  messages?: Message[];
}
export function lintMessage(input: LintInput, env: Record<string, string | undefined> = process.env): string[] {
  if (!lintOn(env)) return [];
  const out: string[] = [];
  const words = wordCount(input.text);
  if (words > MAX_WORDS) out.push(`This is ${words} words (over ${MAX_WORDS}): the person reads it on a phone. Publish the detail as an artifact and link it, or say it shorter.`);
  const codes = internalCodes(input.text);
  if (codes.length) out.push(`It uses internal codes or file paths (${codes.join(', ')}): say what they mean in plain words.`);
  if (input.asking && input.asking.options.length > 0 && !input.asking.options.some(o => o.recommended === true)) out.push('No option is marked recommended: say which one you would pick.');
  if (input.asking && input.messages) {
    const open = openQuestions(input.messages);
    if (open.length) out.push(`This thread already has an open question (${open.map(q => q.id).join(', ')}): ask one at a time, or withdraw the old one.`);
  }
  return out;
}
