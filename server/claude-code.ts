// Claude Code bridge: one inbox thread per Claude Code session.
// Hooks mirror the session into its thread (your terminal prompts as you, Claude's turn-end replies as an agent named after the folder),
// and `wait`, run as an asyncRewake Stop hook, wakes the session when you write in that thread from the inbox.
// With FEEDBACK_ORIGIN_MAP (page origin → folder), a capture taken on a project's page goes to a session working in that folder:
// the first waiting one claims it, is woken with it, and its reply goes to the capture's thread.
import { appendFile, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as store from './store';

// client_id prefix of prompts mirrored from the terminal: the session already has them, so they never wake it
export const MIRROR = 'cc-';
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_WAKE = 8000;

// `seen`: per thread the session follows (its own and the captures it claimed), the newest message of yours it was woken with.
// `reply`: where this turn's final message goes (a claimed capture, or a side question), set when the session is woken.
// `delivered`: fingerprints of messages already woken with, so a copy a merge or move brings into another followed thread never wakes twice.
export interface Session { session_id: string; thread: string; name: string; cwd: string; seen: Record<string, string>; delivered?: string[]; next_flag?: store.Flag; reply?: { thread: string; aside?: string }; ended?: boolean }
export interface HookInput { session_id?: unknown; cwd?: unknown; prompt?: unknown; last_assistant_message?: unknown; reason?: unknown }
export type Projects = Record<string, string>;

const claudeDir = (dir: string) => join(dir, '_claude');
const sessionDir = (dir: string, id: string) => join(claudeDir(dir), id);
const sessionFile = (dir: string, id: string) => join(sessionDir(dir, id), 'session.json');
const pidFile = (dir: string, id: string) => join(sessionDir(dir, id), 'waiter.pid');
const claimFile = (dir: string, thread: string) => join(claudeDir(dir), 'claims', thread);
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

// FEEDBACK_ORIGIN_MAP: a JSON file mapping a page origin to the folder whose sessions handle its captures.
export function loadProjects(env: Record<string, string | undefined> = process.env): Projects {
  const file = env.FEEDBACK_ORIGIN_MAP?.trim();
  if (!file) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).flatMap(([origin, folder]) => {
      try { return typeof folder === 'string' ? [[new URL(origin).origin, resolve(folder)]] : []; } catch { return []; }
    }));
  } catch { return {}; }
}
// Whether a capture taken on `url` belongs to a session working in `cwd` (the project folder or anywhere inside it).
export function ownsCapture(projects: Projects, cwd: string, url: unknown): boolean {
  if (typeof url !== 'string') return false;
  let origin: string;
  try { origin = new URL(url).origin; } catch { return false; }
  const folder = projects[origin];
  return !!folder && (resolve(cwd) === folder || resolve(cwd).startsWith(`${folder}/`));
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
// The same message after a merge, move or repair-merged: copies keep client_id and author time. A copy that was forwarded or carried after a merge
// gains a "> Sent in <title> after the merge" line (0.9.2); it is dropped so a message without a client_id still matches itself.
const SENT_IN = /^> Sent in [^\n]* after the merge(?:\n\n|$)/;
const fingerprint = (m: store.Message) => {
  if (m.client_id) return m.client_id;
  const text = m.text.replace(SENT_IN, '');
  return `${m.created_at}:${text.length}:${text.slice(0, 40)}`;
};

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
  const session: Session = { session_id: id, thread, name, cwd, seen: { [thread]: new Date().toISOString() } };
  await mkdir(sessionDir(dir, id), { recursive: true });
  await store.writeAtomic(sessionFile(dir, id), JSON.stringify(session, null, 2));
  return { session, created: true };
}

// UserPromptSubmit: your terminal prompt goes in as you, the thread counts as read (you are at the terminal),
// and the turn's reply goes back to the session's own thread.
export async function onPrompt(dir: string, input: HookInput): Promise<void> {
  const text = clip(input.prompt);
  if (!text) return;
  const { session, created } = await ensure(dir, input, text);
  if (!created) await store.appendMessage(dir, session.thread, { author: 'user', text, client_id: mirrorId() });
  await store.markRead(dir, session.thread);
  if (session.reply) await updateSession(dir, session.session_id, s => { delete s.reply; });
}
// Stop: Claude's final message goes in as the agent, to the thread the session was woken from (its own by default).
// It wants you (needs_you) unless `flag` said otherwise for this turn; a woken side question gets a side answer.
export async function onStop(dir: string, input: HookInput): Promise<void> {
  const text = clip(input.last_assistant_message);
  if (!text) return;
  const { session } = await ensure(dir, input);
  const turn = await updateSession(dir, session.session_id, s => { const t = { flag: s.next_flag, reply: s.reply }; delete s.next_flag; delete s.reply; s.ended = false; return t; });
  const target = turn?.reply && await threadExists(dir, turn.reply.thread) ? turn.reply : { thread: session.thread };
  await store.appendMessage(dir, target.thread, target.aside
    ? { author: 'agent', agent_name: session.name, text, aside: true, reply_to: target.aside }
    : { author: 'agent', agent_name: session.name, text, flag: turn?.flag ?? 'needs_you' });
  await store.markAgentRead(dir, target.thread, session.name);
}
// SessionEnd: stop the waiter, hand its captures back for the next session in the folder, and close the thread with a resume note.
export async function onEnd(dir: string, input: HookInput): Promise<void> {
  const id = checkSession(input.session_id);
  await stopWaiter(dir, id);
  const session = await readSession(dir, id);
  if (!session || !(await threadExists(dir, session.thread))) return;
  for (const t of Object.keys(session.seen ?? {})) if (t !== session.thread && (await store.optional(claimFile(dir, t)))?.trim() === id) await rm(claimFile(dir, t), { force: true });
  const reason = typeof input.reason === 'string' && input.reason ? ` (${input.reason})` : '';
  await store.appendMessage(dir, session.thread, { author: 'agent', agent_name: session.name, flag: 'done',
    text: `Session ended${reason}. Nothing reads this thread until it is resumed:\n\n\`cd ${session.cwd} && claude --resume ${id}\`` });
  await updateSession(dir, id, s => { s.ended = true; s.seen = { [s.thread]: s.seen?.[s.thread] ?? new Date().toISOString() }; });
}

// ---- Captures
// Claim a capture for a session: the first claim wins, so two sessions in one folder never both take it.
async function claim(dir: string, thread: string, id: string): Promise<boolean> {
  await mkdir(join(claudeDir(dir), 'claims'), { recursive: true });
  try { await writeFile(claimFile(dir, thread), id, { flag: 'wx' }); } catch { return (await store.optional(claimFile(dir, thread)))?.trim() === id; }
  await updateSession(dir, id, s => { s.seen[thread] ??= ''; });
  return true;
}
// A capture thread of this session's project, or (with `conversations`) a conversation you started in the inbox that no session owns yet.
async function claimable(dir: string, thread: string, session: Session, projects: Projects, conversations = false): Promise<boolean> {
  if (session.seen[thread] !== undefined || (await store.optional(claimFile(dir, thread))) !== null) return false;
  try {
    const item = await store.readItem(await store.itemDir(dir, thread));
    const context = (item.context as { url?: unknown; session?: unknown } | undefined) ?? {};
    if (item.mode === 'thread') return conversations && item.origin === 'user' && context.url === undefined && context.session === undefined;
    return ownsCapture(projects, session.cwd, context.url);
  } catch { return false; }
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

// Messages you wrote in one thread the session follows since it was last woken from it, as the text to wake Claude with (null: nothing new).
// It also records where the reply goes. One thread per wake, so the reply has one place to go; another thread's news wakes the next waiter.
export async function unseen(dir: string, id: string, thread: string): Promise<string | null> {
  const session = await readSession(dir, id);
  if (!session || session.seen?.[thread] === undefined || !(await threadExists(dir, thread))) return null;
  const path = await store.itemDir(dir, thread);
  const item = await store.readItem(path);
  const messages = await store.readMessages(path, item);
  const since = session.seen[thread]!;
  const delivered = new Set(session.delivered ?? []);
  const newer = messages.filter(m => m.author === 'user' && m.created_at > since && !m.divider && !m.moved_to && !m.redacted && !m.client_id?.startsWith(MIRROR));
  const fresh = newer.filter(m => !delivered.has(fingerprint(m)));
  if (!fresh.length) {
    if (newer.length) await updateSession(dir, id, s => { s.seen[thread] = newer[newer.length - 1]!.created_at; });
    return null;
  }
  const last = fresh[fresh.length - 1]!;
  const own = thread === session.thread;
  const aside = fresh.every(m => m.aside) ? last.id : undefined;
  await updateSession(dir, id, s => {
    s.seen[thread] = newer[newer.length - 1]!.created_at;
    s.delivered = [...(s.delivered ?? []), ...fresh.map(fingerprint)].slice(-500);
    if (own && !aside) delete s.reply; else s.reply = { thread, ...(aside ? { aside } : {}) };
  });
  const byId = new Map(messages.map(m => [m.id, m]));
  const capture = item.mode !== 'thread';
  const files = capture ? ['annotated', 'image', 'context_image'].map(k => item[k]).filter((f): f is string => typeof f === 'string').map(f => join(path, f)) : [];
  const parts = fresh.map(m => {
    const quoted = m.reply_to ? byId.get(m.reply_to) : undefined;
    return [
      `${m.aside ? 'Side question (/btw)' : m.answer ? 'Answer' : 'Message'} ${m.id}, ${m.created_at.slice(11, 16)} UTC:`,
      ...(quoted ? [`(quoting ${quoted.author} ${quoted.id}: ${quoted.text.split('\n')[0]!.slice(0, 120)})`] : []),
      m.text,
      ...m.images.map(f => `[image: ${join(path, f)}]`),
    ].join('\n');
  });
  const url = (item.context as { url?: unknown } | undefined)?.url;
  const head = !capture
    ? `📬 You wrote in the inbox (thread ${thread}${own ? '' : `, "${String(item.title ?? '')}"`}). Treat it as your next message from the user; your final reply goes back to that thread by itself.`
    : `📬 Feedback capture from ${String(url)} (thread ${thread}, ${String(item.mode)} capture). Treat it as your next message from the user: fix what it asks in this project. Your final reply goes to that thread by itself.\nNote, page context and target: ${join(path, 'feedback.md')}\nScreenshots: ${files.join(', ')}`;
  const body = `${head}\n\n${parts.join('\n\n---\n\n')}`;
  return body.length > MAX_WAKE ? `${body.slice(0, MAX_WAKE)}\n…(cut: read the rest with \`inbox read ${thread}\`)` : body;
}

async function readFrom(file: string, offset: number): Promise<{ lines: string[]; end: number }> {
  let size = 0;
  try { size = (await stat(file)).size; } catch { return { lines: [], end: 0 }; }
  if (size <= offset) return { lines: [], end: size < offset ? size : offset };
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n') + 1; // a line still being written waits for the next look
    return { lines: text.slice(0, cut).split('\n').filter(Boolean), end: offset + Buffer.byteLength(text.slice(0, cut)) };
  } finally { await fh.close(); }
}

// `conversations`: also claim conversations you start in the inbox (FEEDBACK_CLAIM_CONVERSATIONS=1), so one session answers them.
export interface WaitOptions { poll?: number; out?: (text: string) => void; orphaned?: () => boolean; projects?: Projects; conversations?: boolean }
// Runs until you write in a thread the session follows, or a capture for its project arrives (prints it, returns 2 so asyncRewake wakes
// Claude), a newer waiter takes over, or Claude Code goes away (both return 0, which wakes nobody). One waiter per session.
export async function wait(dir: string, input: HookInput, options: WaitOptions = {}): Promise<number> {
  const id = checkSession(input.session_id);
  const poll = options.poll ?? 1000, out = options.out ?? (t => process.stderr.write(`${t}\n`));
  const orphaned = options.orphaned ?? (() => process.ppid === 1);
  const projects = options.projects ?? loadProjects();
  const conversations = options.conversations ?? false;
  let session = await readSession(dir, id);
  for (let i = 0; i < 20 && !session; i++) { await sleep(250); session = await readSession(dir, id); } // the Stop mirror may still be making the thread
  if (!session) return 0;
  await stopWaiter(dir, id);
  await store.writeAtomic(pidFile(dir, id), String(process.pid));
  const events = join(dir, '_events.jsonl');
  let offset = (await readFrom(events, Number.MAX_SAFE_INTEGER)).end; // from now: what came before is caught by the scan below
  const wake = async (thread: string) => { const text = await unseen(dir, id, thread); if (!text) return false; await rm(pidFile(dir, id), { force: true }); out(text); return true; };
  // Anything that arrived while no waiter ran: news in followed threads, then open captures for this project nobody has taken.
  for (const t of Object.keys(session.seen ?? {})) if (await wake(t)) return 2;
  if (Object.keys(projects).length || conversations) {
    const open = (await store.listThreads(dir)).filter(t => t.status === 'open' && t.waiting === 'agent' && (t.mode === 'thread' ? conversations : ownsCapture(projects, session!.cwd, t.url)));
    for (const t of open.reverse()) {
      if (await claimable(dir, t.id, session, projects, conversations) && await claim(dir, t.id, id) && await wake(t.id)) return 2;
    }
  }
  for (;;) {
    if (!(await stillMine(dir, id)) || orphaned()) return 0;
    const { lines, end } = await readFrom(events, offset);
    offset = end;
    for (const line of lines) {
      let e: { id?: unknown; author?: unknown; kind?: unknown; first_line?: unknown };
      try { e = JSON.parse(line); } catch { continue; }
      if (e.author !== 'user' || typeof e.id !== 'string') continue;
      session = (await readSession(dir, id)) ?? session;
      // A key saved in the key box adds no message, only this event ("<name> saved"; never the value).
      if (e.kind === 'secret' && session.seen?.[e.id] !== undefined) {
        await rm(pidFile(dir, id), { force: true });
        out(`🔑 You saved a key in the inbox's secure box (thread ${e.id}): ${String(e.first_line ?? '').slice(0, 80)}. The value went straight to the app, not here; carry on with what needed it.`);
        return 2;
      }
      if (session.seen?.[e.id] !== undefined) { if (await wake(e.id)) return 2; continue; }
      if (e.kind === 'thread' && await claimable(dir, e.id, session, projects, conversations) && await claim(dir, e.id, id) && await wake(e.id)) return 2;
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
      if (command === 'wait') return await wait(dir, input, { projects: loadProjects(env), conversations: /^(1|on|true|yes)$/i.test(env.FEEDBACK_CLAIM_CONVERSATIONS?.trim() ?? '') });
      await hook[command](dir, input);
    } catch (error) {
      await mkdir(claudeDir(dir), { recursive: true }).catch(() => {});
      await appendFile(join(claudeDir(dir), 'errors.log'), `${new Date().toISOString()} ${command}: ${(error as Error).message}\n`).catch(() => {});
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
