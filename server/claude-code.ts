// Claude Code bridge: one inbox thread per Claude Code session.
// Hooks mirror the session into its thread (your terminal prompts as you, Claude's turn-end replies as an agent named after the folder),
// and `wait`, run as an asyncRewake Stop hook, wakes the session when you write in that thread from the inbox.
import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as store from './store';

// client_id prefix of prompts mirrored from the terminal: the session already has them, so they never wake it
export const MIRROR = 'cc-';
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_WAKE = 8000;

export interface Session { session_id: string; thread: string; name: string; cwd: string; seen_at: string; next_flag?: store.Flag; aside?: string; ended?: boolean }
export interface HookInput { session_id?: unknown; cwd?: unknown; prompt?: unknown; last_assistant_message?: unknown; reason?: unknown }

const sessionDir = (dir: string, id: string) => join(dir, '_claude', id);
const sessionFile = (dir: string, id: string) => join(sessionDir(dir, id), 'session.json');
const pidFile = (dir: string, id: string) => join(sessionDir(dir, id), 'waiter.pid');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function checkSession(id: unknown): string {
  if (typeof id !== 'string' || !SESSION.test(id)) throw new store.Invalid('No Claude Code session id');
  return id;
}
export async function readSession(dir: string, id: string): Promise<Session | null> {
  const text = await store.optional(sessionFile(dir, id));
  if (!text) return null;
  try { return JSON.parse(text) as Session; } catch { return null; }
}
async function updateSession<T>(dir: string, id: string, fn: (s: Session) => T): Promise<T | null> {
  return store.withLock(sessionDir(dir, id), async () => {
    const s = await readSession(dir, id);
    if (!s) return null;
    const out = fn(s);
    await store.writeAtomic(sessionFile(dir, id), JSON.stringify(s, null, 2));
    return out;
  });
}

// The folder name names the agent; one that is reserved or too long falls back to "Claude".
export function agentName(cwd: string): string {
  const name = basename(cwd).slice(0, store.MAX_NAME);
  try { return store.checkAgentName(name) ?? 'Claude'; } catch { return 'Claude'; }
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'session';
export function clip(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  return text.length > store.MAX_TEXT ? `${text.slice(0, store.MAX_TEXT - 20)}\n\n…(cut)` : text;
}
function titleOf(text: string): string {
  const line = text.split('\n').find(l => l.trim())?.trim() ?? 'Claude Code session';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
const mirrorId = () => `${MIRROR}${randomBytes(8).toString('hex')}`;

async function threadExists(dir: string, id: string): Promise<boolean> {
  try { await store.itemDir(dir, id); return true; } catch { return false; }
}
// A thread with a url is grouped like a capture (areas.js), so /claude/<folder> puts each folder's sessions together.
async function setContext(dir: string, thread: string, context: Record<string, string>): Promise<void> {
  const path = await store.itemDir(dir, thread);
  await store.withLock(path, async () => {
    const item = await store.readItem(path);
    await store.writeAtomic(join(path, 'item.json'), JSON.stringify({ ...item, context: { ...(item.context as object | undefined), ...context } }, null, 2));
  });
}
// The session's thread, made on first use: from the first prompt (as you) or, for a session that predates the bridge, a note from the agent.
async function ensure(dir: string, input: HookInput, first?: string): Promise<{ session: Session; created: boolean }> {
  const id = checkSession(input.session_id);
  const existing = await readSession(dir, id);
  if (existing && await threadExists(dir, existing.thread)) return { session: existing, created: false };
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const name = agentName(cwd);
  const { id: thread } = first
    ? await store.createThread(dir, { title: titleOf(first), text: first, origin: 'user' })
    : await store.createThread(dir, { title: `${name} session`, text: `Claude Code session in ${cwd}`, origin: 'agent', agent_name: name, flag: 'fyi' });
  await setContext(dir, thread, { url: `/claude/${slug(name)}`, cwd, session: id });
  const session: Session = { session_id: id, thread, name, cwd, seen_at: new Date().toISOString() };
  await mkdir(sessionDir(dir, id), { recursive: true });
  await store.writeAtomic(sessionFile(dir, id), JSON.stringify(session, null, 2));
  return { session, created: true };
}

// UserPromptSubmit: your terminal prompt goes in as you, and the thread counts as read (you are at the terminal).
export async function onPrompt(dir: string, input: HookInput): Promise<void> {
  const text = clip(input.prompt);
  if (!text) return;
  const { session, created } = await ensure(dir, input, text);
  if (!created) await store.appendMessage(dir, session.thread, { author: 'user', text, client_id: mirrorId() });
  await store.markRead(dir, session.thread);
}
// Stop: Claude's final message goes in as the agent. It wants you (needs_you) unless `flag` said otherwise for this turn,
// and it answers a side question when that is all the turn was woken for.
export async function onStop(dir: string, input: HookInput): Promise<void> {
  const text = clip(input.last_assistant_message);
  if (!text) return;
  const { session } = await ensure(dir, input);
  const turn = await updateSession(dir, session.session_id, s => { const t = { flag: s.next_flag, aside: s.aside }; delete s.next_flag; delete s.aside; s.ended = false; return t; });
  const aside = turn?.aside;
  await store.appendMessage(dir, session.thread, aside
    ? { author: 'agent', agent_name: session.name, text, aside: true, reply_to: aside }
    : { author: 'agent', agent_name: session.name, text, flag: turn?.flag ?? 'needs_you' });
  await store.markAgentRead(dir, session.thread, session.name);
}
// SessionEnd: stop the waiter and close the thread with a note on how to pick it up again.
export async function onEnd(dir: string, input: HookInput): Promise<void> {
  const id = checkSession(input.session_id);
  await stopWaiter(dir, id);
  const session = await readSession(dir, id);
  if (!session || !(await threadExists(dir, session.thread))) return;
  const reason = typeof input.reason === 'string' && input.reason ? ` (${input.reason})` : '';
  await store.appendMessage(dir, session.thread, { author: 'agent', agent_name: session.name, flag: 'done',
    text: `Session ended${reason}. Nothing reads this thread until it is resumed:\n\n\`cd ${session.cwd} && claude --resume ${id}\`` });
  await updateSession(dir, id, s => { s.ended = true; });
}

// ---- The waiter
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function isWaiter(pid: number): boolean {
  const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)]);
  return ps.exitCode === 0 && /claude-code\s+wait/.test(ps.stdout.toString());
}
export async function stopWaiter(dir: string, id: string): Promise<void> {
  const pid = Number(await store.optional(pidFile(dir, id)));
  if (pid > 1 && pid !== process.pid && alive(pid) && isWaiter(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  await rm(pidFile(dir, id), { force: true });
}
async function stillMine(dir: string, id: string): Promise<boolean> { return Number(await store.optional(pidFile(dir, id))) === process.pid; }

// Messages you wrote in the inbox since the waiter last delivered, as the text Claude is woken with (null: nothing new).
export async function unseen(dir: string, id: string): Promise<string | null> {
  const session = await readSession(dir, id);
  if (!session || !(await threadExists(dir, session.thread))) return null;
  const path = await store.itemDir(dir, session.thread);
  const messages = await store.readMessages(path, await store.readItem(path));
  const fresh = messages.filter(m => m.author === 'user' && m.created_at > session.seen_at && !m.divider && !m.moved_to && !m.redacted && !m.client_id?.startsWith(MIRROR));
  if (!fresh.length) return null;
  const byId = new Map(messages.map(m => [m.id, m]));
  const asides = fresh.every(m => m.aside);
  await updateSession(dir, id, s => { s.seen_at = fresh[fresh.length - 1]!.created_at; if (asides) s.aside = fresh[fresh.length - 1]!.id; else delete s.aside; });
  const parts = fresh.map(m => {
    const quoted = m.reply_to ? byId.get(m.reply_to) : undefined;
    const lines = [
      `${m.aside ? 'Side question (/btw)' : m.answer ? 'Answer' : 'Message'} ${m.id}, ${m.created_at.slice(11, 16)} UTC:`,
      ...(quoted ? [`(quoting ${quoted.author} ${quoted.id}: ${quoted.text.split('\n')[0]!.slice(0, 120)})`] : []),
      m.text,
      ...m.images.map(f => `[image: ${join(path, f)}]`),
    ];
    return lines.join('\n');
  });
  const body = `📬 You wrote in the inbox (thread ${session.thread}). Treat it as your next message from the user; your final reply goes back to the thread by itself.\n\n${parts.join('\n\n---\n\n')}`;
  return body.length > MAX_WAKE ? `${body.slice(0, MAX_WAKE)}\n…(cut: read the rest with \`react-feedback read ${session.thread}\`)` : body;
}

export interface WaitOptions { poll?: number; out?: (text: string) => void; orphaned?: () => boolean }
// Runs until you write in the session's thread (prints it, returns 2 so asyncRewake wakes Claude), a newer waiter takes over,
// or Claude Code goes away (both return 0, which wakes nobody). One waiter per session: starting one stops the last.
export async function wait(dir: string, input: HookInput, options: WaitOptions = {}): Promise<number> {
  const id = checkSession(input.session_id);
  const poll = options.poll ?? 1000, out = options.out ?? (t => process.stderr.write(`${t}\n`));
  const orphaned = options.orphaned ?? (() => process.ppid === 1);
  let session = await readSession(dir, id);
  for (let i = 0; i < 20 && !session; i++) { await sleep(250); session = await readSession(dir, id); } // the Stop mirror may still be making the thread
  if (!session) return 0;
  await stopWaiter(dir, id);
  await store.writeAtomic(pidFile(dir, id), String(process.pid));
  let path: string;
  try { path = join(await store.itemDir(dir, session.thread), 'thread.jsonl'); } catch { return 0; }
  let size = -1;
  for (;;) {
    if (!(await stillMine(dir, id)) || orphaned()) return 0;
    let now = -1;
    try { now = (await stat(path)).size; } catch { /* moved or merged away */ }
    if (now !== size) {
      size = now;
      const text = await unseen(dir, id);
      if (text) { await rm(pidFile(dir, id), { force: true }); out(text); return 2; }
    }
    await sleep(poll);
  }
}

// ---- Commands
// Hooks: `prompt`, `stop`, `end` and `wait` read the hook's JSON on stdin. A hook never fails the session: errors go to _claude/errors.log.
// From inside a session (CLAUDE_CODE_SESSION_ID): `id`, `title "text"`, `flag done|fyi|needs_you`.
const OFF = /^(0|off|false|no)$/i;
export async function runClaudeCode(argv: string[], dir: string, env: Record<string, string | undefined> = process.env, stdin: () => Promise<string> = () => Bun.stdin.text()): Promise<number> {
  const [command, ...rest] = argv;
  const hook = { prompt: onPrompt, stop: onStop, end: onEnd } as const;
  if (command === 'prompt' || command === 'stop' || command === 'end' || command === 'wait') {
    if (OFF.test(env.REACT_FEEDBACK_CLAUDE?.trim() ?? '') || /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT ?? '')) return 0; // switched off, or a headless (-p / Agent SDK) run
    let input: HookInput;
    try { input = JSON.parse(await stdin()) as HookInput; } catch { return 0; }
    try {
      if (command === 'wait') return await wait(dir, input);
      await hook[command](dir, input);
    } catch (error) {
      await mkdir(join(dir, '_claude'), { recursive: true }).catch(() => {});
      await appendFile(join(dir, '_claude', 'errors.log'), `${new Date().toISOString()} ${command}: ${(error as Error).message}\n`).catch(() => {});
    }
    return 0;
  }
  const id = checkSession(env.CLAUDE_CODE_SESSION_ID);
  let session = await readSession(dir, id);
  for (let i = 0; i < 12 && !session; i++) { await sleep(250); session = await readSession(dir, id); } // the async prompt hook may still be making the thread
  if (!session) throw new store.Invalid('This session has no inbox thread yet (it gets one with its first prompt)');
  if (command === 'id' && rest.length === 0) { console.log(session.thread); return 0; }
  if (command === 'title' && rest.length === 1) {
    const title = store.threadTitle(rest[0]);
    const path = await store.itemDir(dir, session.thread);
    await store.withLock(path, async () => { await store.writeAtomic(join(path, 'item.json'), JSON.stringify({ ...(await store.readItem(path)), title }, null, 2)); });
    console.log(`Titled ${session.thread}: ${title}`);
    return 0;
  }
  if (command === 'flag' && rest.length === 1) {
    const flag = store.checkFlag(rest[0]);
    await updateSession(dir, id, s => { s.next_flag = flag; });
    console.log(`This turn's reply goes in as ${flag}`);
    return 0;
  }
  throw new store.Invalid('Usage: react-feedback claude-code prompt|stop|end|wait (hooks, JSON on stdin) | id | title "text" | flag done|fyi|needs_you');
}
