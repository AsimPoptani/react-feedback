// Agent CLI (react-feedback <command>). Writes straight into FEEDBACK_DIR through the same store the server uses.
//   react-feedback reply <id> "text" [--image path ...] [--to <message-id>]   (quote one of the thread's messages)
//   react-feedback reply <id> "text" --aside --to <aside-id>   (answer a side question)
//   react-feedback reply <id> "text" --todo "item" ... [--for agent|user] [--check c3 ...]   (checklist changes ride on the reply)
//   react-feedback new "title" "text" [--image path ...]
//   react-feedback status <id> open|done   (seen is an alias for open)
//   react-feedback list [--waiting]   (--unread is an alias)
//   react-feedback read <id>   (marks it read, then prints the thread with each quote's context)
//   react-feedback ask <id> "prompt" --option "Label|description" ... [--multi] [--no-other]
//   react-feedback ask-new "title" "prompt" --option ... [--multi] [--no-other]
//   react-feedback profile agent --avatar path
//   react-feedback reply|new|ask ... [--needs-you | --done | --fyi]   (flag on the message; default fyi, ask defaults to needs-you)
//   react-feedback todo <id> add agent|user "text"
//   react-feedback todo <id> list | done|check <item> | uncheck <item> | unclaim <item> "why" | edit <item> "text" | rm <item>
//   react-feedback todos [--mine | --claimed]
//   react-feedback merge <from-id> <into-id>
//   react-feedback move <from-id> <message-id> [<message-id> ...] --to <into-id>   (move messages to another thread)
//   react-feedback new "title" "text" --read-only     (a thread the user cannot reply to)
//   react-feedback readonly <id> on|off
//   react-feedback ack <id>     (the user's latest message is handled; no reply)
//   react-feedback tracker [--mine | --claimed | --open]   (every checklist item across the threads)
//   react-feedback metrics [--window 24h|7d|all]
//   react-feedback ask-secret <id> --name <key-name> --label "Label" [--help-url <https url>]   (a secure key box in the thread; the value never comes here)
//   react-feedback redact <id> <message-id> [--reason "..."]   (text and images move to the vault: FEEDBACK_VAULT_DIR)
//   react-feedback unredact <id> <message-id>   (restore from the vault; CLI only)
//   react-feedback remind <id> add --every 2h|--after-replies 3|--idle 1h --say "..."   (a nudge in your event feed)
//   react-feedback remind <id> list | remove <rid> | off-default | on-default
//   react-feedback mcp   (an MCP server on stdio: FEEDBACK_AGENT_NAME names this agent)
//   react-feedback --version
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as store from './store';
import { asideGroups } from './inbox/aside.js';
import { ageOf, stateOf } from './inbox/tracker.js';
import { checkWindow, computeMetrics, formatMetrics } from './metrics';
import { loadAreas, loadVaultDir } from './config';
import { redactMessage, unredactMessage } from './sensitive';
import type { AreasConfig } from './inbox/areas.js';
import * as reminders from './reminders';
import { presenceLines } from './inbox/presence.js';
import { packageVersion } from './version';

export const defaultDir = () => process.env.FEEDBACK_DIR ?? resolve(process.cwd(), 'feedback-data');
const USAGE = `Usage:
  react-feedback serve   (FEEDBACK_DIR, FEEDBACK_HOST, PORT, FEEDBACK_AREAS or FEEDBACK_AREAS_JSON, FEEDBACK_SECRET_TARGET, FEEDBACK_VAULT_DIR)
  react-feedback --help
  react-feedback --version
  react-feedback reply <id> "text" [--image path ...] [--to <message-id>]
  react-feedback reply <id> "text" --aside --to <aside-id>   (answer a side question the user sent with /btw)
  react-feedback reply <id> "text" --todo "item" [--todo "item" ...] [--for agent|user] [--check c3 ...]
  react-feedback new "title" "text" [--image path ...]
  react-feedback status <id> open|done   (seen is an alias for open)
  react-feedback list [--waiting]   (--unread is an alias)
  react-feedback read <id>   (marks it read and prints the thread)
  react-feedback ask <id> "prompt" --option "Label|optional description" ... [--multi] [--no-other] [--to <message-id>]
  react-feedback ask-new "title" "prompt" --option ... [--multi] [--no-other]
  react-feedback profile agent --avatar path
  react-feedback reply|new|ask ... [--needs-you | --done | --fyi]
  react-feedback todo <id> add agent|user "text"
  react-feedback todo <id> list | done <item> (or check) | uncheck <item> | unclaim <item> "why" | edit <item> "text" | rm <item>
  react-feedback todos [--mine | --claimed]
  react-feedback merge <from-id> <into-id>
  react-feedback move <from-id> <message-id> [<message-id> ...] --to <into-id>
  react-feedback new "title" "text" --read-only
  react-feedback readonly <id> on|off
  react-feedback ack <id>
  react-feedback tracker [--mine | --claimed | --open]
  react-feedback metrics [--window 24h|7d|all]
  react-feedback ask-secret <id> --name <key-name> --label "Label" [--help-url <https url>]
  react-feedback redact <id> <message-id> [--reason "why"]   (needs FEEDBACK_VAULT_DIR)
  react-feedback unredact <id> <message-id>
  react-feedback remind <id> add --every 2h|--after-replies 3|--idle 1h --say "text"
  react-feedback remind <id> list | remove <rid> | off-default | on-default   (FEEDBACK_DEFAULT_REMINDER=off turns the built-in one off everywhere)
  react-feedback mcp   (an MCP server on stdio; FEEDBACK_AGENT_NAME names the agent)`;

function split(args: string[]): { words: string[]; images: string[]; flags: string[]; options: string[]; avatar: string | null; window: string | null; to: string | null; todos: string[]; checks: string[]; owner: string | null; named: Record<string, string> } {
  const words: string[] = [], images: string[] = [], flags: string[] = [], options: string[] = [], todos: string[] = [], checks: string[] = [];
  let avatar: string | null = null, window: string | null = null, to: string | null = null, owner: string | null = null;
  const named: Record<string, string> = {};
  let collecting = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--image') { collecting = true; continue; }
    if (arg === '--option' || arg === '--avatar' || arg === '--window' || arg === '--to' || arg === '--todo' || arg === '--check' || arg === '--for') {
      const value = args[++i];
      if (value === undefined) throw new store.Invalid(`${arg} needs a value`);
      if (arg === '--option') options.push(value); else if (arg === '--window') window = value; else if (arg === '--to') to = value; else if (arg === '--todo') todos.push(value); else if (arg === '--check') checks.push(value); else if (arg === '--for') owner = value; else avatar = value;
      collecting = false; continue;
    }
    if (arg === '--name' || arg === '--label' || arg === '--help-url' || arg === '--reason' || arg === '--every' || arg === '--after-replies' || arg === '--idle' || arg === '--say') {
      const value = args[++i];
      if (value === undefined) throw new store.Invalid(`${arg} needs a value`);
      named[arg.slice(2)] = value; collecting = false; continue;
    }
    if (arg.startsWith('--')) { flags.push(arg); collecting = false; continue; }
    (collecting ? images : words).push(arg);
  }
  return { words, images, flags, options, avatar, window, to, todos, checks, owner, named };
}
function question(prompt: string, options: string[], flags: string[]): store.QuestionInput {
  return { prompt, multi: flags.includes('--multi'), allow_other: !flags.includes('--no-other'),
    options: options.map(o => { const [label, ...rest] = o.split('|'); return { label: label!.trim(), ...(rest.length ? { description: rest.join('|').trim() } : {}) }; }) };
}
async function load(paths: string[]): Promise<store.Image[]> {
  if (paths.length > store.MAX_IMAGES) throw new store.Invalid(`At most ${store.MAX_IMAGES} images per message`);
  return Promise.all(paths.map(async path => {
    try { return store.checkedImage(Buffer.from(await readFile(path))); }
    catch (error) { throw error instanceof store.Invalid ? new store.Invalid(`${path}: ${error.message}`) : new store.Invalid(`Cannot read image ${path}`); }
  }));
}
function flagOf(flags: string[]): store.Flag | undefined {
  const named = flags.flatMap(f => (f === '--needs-you' ? ['needs_you' as const] : f === '--done' ? ['done' as const] : f === '--fyi' ? ['fyi' as const] : []));
  if (named.length > 1) throw new store.Invalid('Use only one of --needs-you, --done, --fyi');
  return named[0];
}
const describe = (i: store.ChecklistItem) => `${i.id}  [${i.done ? 'x' : i.claimed_by_user_at ? '?' : ' '}] ${i.owner === 'user' ? 'you  ' : 'agent'}  ${i.text}`
  + `${i.claimed_by_user_at && !i.done ? `  (claimed by the user ${i.claimed_by_user_at.slice(0, 16)})` : ''}${i.unclaim_note && !i.claimed_by_user_at ? `  (unclaimed: ${i.unclaim_note})` : ''}`;
async function todo(dir: string, words: string[]): Promise<string> {
  const [id, verb, a, b] = words;
  if (!id || !verb) throw new store.Invalid(USAGE);
  if (verb === 'list') { const items = await store.listChecklist(dir, id); return items.length ? items.map(describe).join('\n') : 'No checklist items.'; }
  if (verb === 'add' && a && b) return describe(await store.addChecklistItem(dir, id, { owner: a, text: b, by: 'agent' }));
  if (!a) throw new store.Invalid(USAGE);
  if (verb === 'done' || verb === 'check') return describe(await store.patchChecklistItem(dir, id, a, { done: true }, 'agent'));
  if (verb === 'uncheck') return describe(await store.patchChecklistItem(dir, id, a, { done: false }, 'agent'));
  if (verb === 'unclaim' && b) return describe(await store.patchChecklistItem(dir, id, a, { claimed: false, note: b }, 'agent'));
  if (verb === 'edit' && b) return describe(await store.patchChecklistItem(dir, id, a, { text: b }, 'agent'));
  if (verb === 'rm') { await store.deleteChecklistItem(dir, id, a, 'agent'); return `Removed ${a}`; }
  throw new store.Invalid(USAGE);
}
const describeReminder = (r: reminders.Reminder) => `${r.id}  ${r.enabled ? ' ' : '(off) '}${r.kind === 'every' ? `every ${r.value}` : r.kind === 'idle' ? `idle ${r.value}` : `after ${r.value} agent repl${r.value === 1 ? 'y' : 'ies'} with no checklist change`}  "${r.say}"${r.last_fired_at ? `  (last fired ${r.last_fired_at.slice(0, 16)})` : ''}`;
async function remind(dir: string, words: string[], named: Record<string, string>): Promise<string> {
  const [id, verb, rid] = words;
  if (verb === 'list') {
    const v = await reminders.listReminders(dir, id!);
    return [`Built-in checklist reminder: ${v.default.on ? 'on' : v.default.global_off ? 'off everywhere (FEEDBACK_DEFAULT_REMINDER)' : 'off for this thread'}`, ...v.items.map(describeReminder)].join('\n');
  }
  if (verb === 'add') {
    const given = (['every', 'after-replies', 'idle'] as const).filter(k => named[k] !== undefined);
    if (given.length !== 1) throw new store.Invalid('remind add takes exactly one of --every, --after-replies or --idle, and --say "text"');
    const kind = given[0] === 'every' ? 'every' : given[0] === 'idle' ? 'idle' : 'after_agent_replies';
    return `Added ${describeReminder(await reminders.addReminder(dir, id!, { kind, value: named[given[0]!], say: named.say, by: 'agent' }))}`;
  }
  if (verb === 'remove' && rid) { await reminders.removeReminder(dir, id!, rid); return `Removed ${rid}`; }
  if (verb === 'off-default') { await reminders.setDefaultReminder(dir, id!, false); return `The built-in checklist reminder is off for ${id}`; }
  if (verb === 'on-default') { await reminders.setDefaultReminder(dir, id!, true); return `The built-in checklist reminder is on for ${id}`; }
  throw new store.Invalid(USAGE);
}
async function tracker(dir: string, flags: string[]): Promise<string> {
  const t = await store.readTracker(dir);
  const keep = (r: store.TrackerRow) => (flags.includes('--claimed') ? stateOf(r.item) === 'claimed' : flags.includes('--open') ? stateOf(r.item) !== 'done' : true);
  const line = (r: store.TrackerRow) => `  ${r.thread}  ${describe(r.item)}  <${r.title}>  ${ageOf(r.item.created_at)}`;
  const parts: [string, store.TrackerRow[]][] = flags.includes('--mine') ? [['For the agent', t.agent]] : [['For you', t.you], ['For the agent', t.agent], ['Done recently', t.done_recent]];
  const shown = parts.map(([title, rows]) => [title, rows.filter(keep)] as const).filter(([, rows]) => rows.length);
  const head = `${t.counts.done} of ${t.counts.total} done, ${t.counts.claimed} claimed`;
  if (!shown.length) return `${head}\nNothing matches.`;
  return `${head}\n${shown.map(([title, rows]) => `${title}\n${rows.map(line).join('\n')}`).join('\n')}`;
}
async function todos(dir: string, flags: string[]): Promise<string> {
  const filter = flags.includes('--claimed') ? 'claimed' : flags.includes('--mine') ? 'mine' : 'all';
  const rows = await store.openItems(dir, filter);
  if (!rows.length) return filter === 'claimed' ? 'Nothing is waiting for your check.' : filter === 'mine' ? 'No open items for the agent.' : 'No open checklist items.';
  return rows.map(r => `${r.thread}  ${describe(r.item)}  <${r.title}>`).join('\n');
}
// What `read` prints for one message: who, when, the quoted message if it quotes one, then the text, then any checklist items it added or ticked.
// A side question prints indented under "Side question", with its answers beneath it.
const firstLine = (m: store.Message) => m.redacted ? '🔒 Redacted' : (m.text.split('\n').find(l => l.trim()) ?? (m.images.length ? '[image]' : '')).slice(0, 120);
export interface TranscriptExtra { items?: store.ChecklistItem[]; acked?: string | null }
export function transcript(messages: store.Message[], names: Record<store.Author, string> = { user: 'user', agent: 'agent' }, extra: TranscriptExtra = {}): string {
  const byId = new Map(messages.map(m => [m.id, m]));
  const itemText = (id: string) => `${id}${extra.items?.find(i => i.id === id) ? ` ${extra.items.find(i => i.id === id)!.text}` : ''}`;
  const one = (m: store.Message, pad: string, label = ''): string => {
    const quoted = m.reply_to && !m.aside ? byId.get(m.reply_to) : undefined;
    const quote = m.reply_to && !m.aside ? (quoted ? `  (replying to ${quoted.id}, ${names[quoted.author]}: "${firstLine(quoted)}")` : `  (replying to ${m.reply_to}: original unavailable)`) : '';
    const body = m.divider ? `--- ${m.text} ---` : m.redacted ? `  🔒 Redacted (sensitive) by ${m.redacted.by === 'user' ? names.user : names.agent}, ${m.redacted.at.slice(0, 16)}${m.redacted.reason ? `: ${m.redacted.reason}` : ''}`
      : (m.text || (m.images.length ? '[image]' : '')).split('\n').map(l => `  ${l}`).join('\n');
    const secret = m.secret ? [`  [key request ${m.secret.name}: ${m.secret.status === 'saved' ? `saved${m.secret.hint ? `, ends ${m.secret.hint}` : ''}${m.secret.check === 'rejected' ? ', but the provider rejected it' : ''}` : 'not saved yet'}]`] : [];
    const attached = [...(m.added_items?.length ? [`  + added to checklist: ${m.added_items.map(itemText).join('; ')}`] : []), ...(m.ticked_items?.length ? [`  [x] ticked: ${m.ticked_items.map(itemText).join('; ')}`] : [])];
    const text = `${m.id}  ${m.author === 'user' ? 'user ' : 'agent'}  ${m.created_at.slice(0, 16)}${m.written_at && Math.abs(Date.parse(m.created_at) - Date.parse(m.written_at)) > 60e3 ? ` (written ${m.written_at.slice(0, 16)}, sent offline)` : ''}${label}${quote}\n${[body, ...secret, ...attached].join('\n')}`;
    return pad ? text.split('\n').map(l => `${pad}${l}`).join('\n') : text;
  };
  const groups = asideGroups(messages, extra.acked ?? null);
  const inGroup = new Set(groups.flatMap(g => [g.root.id, ...g.answers.map(a => a.id)]));
  const out: string[] = [];
  for (const m of messages) {
    const group = groups.find(g => g.root.id === m.id);
    if (group) out.push(`    Side question${group.answered ? '' : ' (waiting for the agent)'}\n${[group.root, ...group.answers].map(x => one(x, '    ')).join('\n')}`);
    else if (m.aside) { if (!inGroup.has(m.id)) out.push(`    Side question (orphan)\n${one(m, '    ')}`); } // an answer whose question is gone
    else out.push(one(m, ''));
  }
  return out.join('\n');
}
// The presence lines for the agent: "Claude · active 2 min ago" for each agent and "You · last seen 2026-11-19 10:42 UTC" (UTC, since a terminal has no viewer zone).
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
export async function presenceText(dir: string, now = Date.now()): Promise<string> {
  return presenceLines(await store.readPresence(dir), now, { agentName: (await store.readProfile(dir)).agent.name, clock: utc }).map(l => l.text).join('\n');
}
async function list(dir: string, waiting: boolean): Promise<string> {
  const rows = (await store.listThreads(dir)).filter(t => !waiting || t.waiting === 'agent' || t.waiting_aside);
  const seen = await presenceText(dir), tail = seen ? `\n\n${seen}` : ''; // after the rows, so a script reading the rows is not disturbed
  if (!rows.length) return (waiting ? 'Nothing is waiting for the agent.' : 'No threads.') + tail;
  return rows.map(t => `${t.id}  ${t.waiting.padEnd(5)}  ${t.last_author === 'user' ? 'user ' : 'agent'}  ${t.last_message_at.slice(0, 16)}  ${t.title}${t.waiting_aside ? '  [side question waiting]' : ''}`).join('\n') + tail;
}
// `notice` receives hints that are advice, not results: they go to stderr, so a wrapper that reads the command's output is not affected.
export async function run(argv: string[], dir = defaultDir(), areas?: AreasConfig, env: Record<string, string | undefined> = process.env, notice: (line: string) => void = line => { process.stderr.write(`${line}\n`); }): Promise<string> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') return USAGE;
  if (command === '--version') return packageVersion();
  const { words, images, flags, options, avatar, window, to, todos: addTodos, checks, owner, named } = split(rest);
  await store.touchPresence(dir, { agent: undefined }); // any command is the agent being here
  if (command === 'todo') return todo(dir, words);
  if (command === 'merge' && words.length === 2) {
    const r = await store.mergeThreads(dir, words[0]!, words[1]!, 'agent');
    return r.merged ? `Merged ${words[0]} into ${words[1]}` : `${words[0]} was already merged into ${words[1]}`;
  }
  if (command === 'move' && words.length >= 2) {
    if (!to) throw new store.Invalid('move needs --to <thread>');
    const r = await store.moveMessages(dir, words[0]!, words.slice(1), to, 'agent');
    return r.moved.length ? `Moved ${r.moved.join(' ')} from ${words[0]} to ${to}` : `Those messages were already moved to ${to}`;
  }
  if (command === 'ask-secret' && words.length === 1) {
    if (!named.name || !named.label) throw new store.Invalid('ask-secret needs --name and --label');
    const message = await store.appendMessage(dir, words[0]!, { author: 'agent', text: undefined, flag: flagOf(flags), secret: { name: named.name, label: named.label, help_url: named['help-url'] } });
    return `Asked for ${named.name} on ${words[0]} (${message.id}); the value goes straight to the app and never comes here`;
  }
  if (command === 'redact' && words.length === 2) {
    const r = await redactMessage(dir, words[0]!, words[1]!, { by: 'agent', reason: named.reason, vault: loadVaultDir(env) });
    const warn = r.failed.length ? `\nWARNING: could not redact these copies (run the same command again): ${r.failed.join('; ')}` : '';
    return (r.redacted ? `Redacted ${words[1]} on ${words[0]}: its text and images are in the vault` : `${words[1]} on ${words[0]} was already redacted`) + warn;
  }
  if (command === 'unredact' && words.length === 2) {
    const r = await unredactMessage(dir, words[0]!, words[1]!, loadVaultDir(env));
    return r.restored ? `Restored ${words[1]} on ${words[0]} from the vault` : `${words[1]} on ${words[0]} was not redacted`;
  }
  if (command === 'remind' && words.length >= 2) return remind(dir, words, named);
  if (command === 'todos') return todos(dir, flags);
  if (command === 'tracker' && words.length === 0) return tracker(dir, flags);
  if (command === 'metrics' && words.length === 0) return formatMetrics(await computeMetrics(dir, checkWindow(window ?? '7d'), new Date(), areas ?? loadAreas()));
  if (command === 'ack' && words.length === 1) { await store.ackThread(dir, words[0]!); return `Acknowledged the latest message on ${words[0]}`; }
  if (command === 'readonly' && words.length === 2 && (words[1] === 'on' || words[1] === 'off')) {
    await store.setReadOnly(dir, words[0]!, words[1] === 'on');
    return `${words[0]} is ${words[1] === 'on' ? 'now read-only' : 'open to replies again'}`;
  }
  if (command === 'list') return list(dir, flags.includes('--waiting') || flags.includes('--unread'));
  if (command === 'status' && words.length === 2) {
    const status = store.checkStatus(words[1]);
    await store.setStatus(dir, words[0]!, status);
    return `${words[0]} ${status}`;
  }
  if (command === 'reply' && words.length === 2) {
    const aside = flags.includes('--aside');
    if (owner !== null && !addTodos.length) throw new store.Invalid('--for goes with --todo');
    const message = await store.appendMessage(dir, words[0]!, { author: 'agent', text: words[1], images: await load(images), flag: flagOf(flags), reply_to: to ?? undefined, ...(aside ? { aside: true } : {}),
      ...(addTodos.length ? { add_items: addTodos.map(text => ({ owner: owner ?? 'agent', text })) } : {}), ...(checks.length ? { check_items: checks } : {}) });
    const closed = message.flag === 'done' ? ((await store.readStatus(await store.itemDir(dir, words[0]!))) === 'done' ? ', thread closed' : ', thread left open: the user still has open items') : '';
    const extras = `${aside ? `, side answer to ${message.reply_to}` : ''}${message.added_items ? `, added ${message.added_items.join(' ')}` : ''}${message.ticked_items ? `, ticked ${message.ticked_items.join(' ')}` : ''}`;
    await reminders.checkAfterReply(dir, words[0]!);
    const open = !aside && !addTodos.length && !checks.length ? await reminders.openAgentItems(dir, words[0]!) : [];
    if (open.length) notice(`${open.length} open item${open.length === 1 ? '' : 's'} here; tick any you shipped with --check cN (open: ${open.map(i => i.id).join(' ')})`);
    return `Replied to ${words[0]} (${message.id}${message.images.length ? `, ${message.images.join(' ')}` : ''}${extras}${closed})`;
  }
  if (command === 'read' && words.length === 1) {
    await store.markAgentRead(dir, words[0]!);
    const { messages, summary, path } = await store.summarise(dir, words[0]!);
    const seen = await presenceText(dir);
    return `Marked ${words[0]} read${messages.length ? `\n\n${transcript(messages, undefined, { items: await store.readChecklist(path), acked: summary.acked_through })}` : ''}${seen ? `\n\n${seen}` : ''}`;
  }
  if (command === 'ask' && words.length === 2) {
    const message = await store.appendMessage(dir, words[0]!, { author: 'agent', text: words[1], question: question(words[1]!, options, flags), flag: flagOf(flags), reply_to: to ?? undefined });
    return `Asked on ${words[0]} (${message.id}, question ${message.question!.id})`;
  }
  if (command === 'ask-new' && words.length === 2) {
    const { id } = await store.createThread(dir, { title: words[0], text: words[1], origin: 'agent', question: question(words[1]!, options, flags), flag: flagOf(flags) });
    return `Started ${id} (question q1)`;
  }
  if (command === 'profile' && words.length === 1 && words[0] === 'agent' && avatar) {
    try { await store.setAgentAvatar(dir, Buffer.from(await readFile(avatar))); }
    catch (error) { throw error instanceof store.Invalid ? error : new store.Invalid(`Cannot read image ${avatar}`); }
    return 'Set the agent avatar';
  }
  if (command === 'new' && words.length === 2) {
    const { id } = await store.createThread(dir, { title: words[0], text: words[1], images: await load(images), origin: 'agent', flag: flagOf(flags), readOnly: flags.includes('--read-only') });
    return `Started ${id}${flags.includes('--read-only') ? ' (read-only)' : ''}`;
  }
  throw new store.Invalid(USAGE);
}
if (import.meta.main) {
  run(process.argv.slice(2)).then(out => console.log(out)).catch(error => {
    console.error(error instanceof store.Invalid ? error.message : error);
    process.exit(error instanceof store.Invalid ? 2 : 1);
  });
}
