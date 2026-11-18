import type { Capture } from './types';
import type { OutboxRecord, OutboxStore } from './outboxStore';
type Body = Record<string, unknown>;
export type OutboxStatus = 'capturing' | 'queued' | 'sending' | 'retrying' | 'failed';
export interface OutboxView { id: string; label: string; text: string; status: OutboxStatus; reason?: string; attempts: number; stuck: boolean }
export interface OutboxSnapshot { items: OutboxView[]; pending: number; failed: number; persistent: boolean }
export interface OutboxJob {
  id: string; label: string; text: string;
  /** The finished picture, or the capture still running. */
  capture: Capture | Promise<Capture>;
  /** Builds the request body from the picture, or from nothing when the capture failed. */
  build: (capture: Capture | null) => Body;
}
interface Entry extends OutboxRecord { pending?: Promise<unknown>; sending: boolean; attempts: number; nextAt: number }
/** Retry waits in ms; after the last, every minute. */
/** After this many failed attempts an item stops blocking the ones behind it. */
export const STUCK_AFTER = 3;
export const BACKOFF = [2000, 5000, 15000, 30000, 60000];
const SEND_TIMEOUT = 90000;
export const EMPTY: OutboxSnapshot = { items: [], pending: 0, failed: 0, persistent: true };
const RETRY_STATUS = new Set([408, 429]);
function tooLarge(status: number) { return status === 413; }
async function refusal(response: Response) {
  if (tooLarge(response.status)) return 'Too large for the feedback server. Discard it and capture a smaller area.';
  const detail = await response.json().then((data: { detail?: unknown }) => (typeof data.detail === 'string' ? data.detail : ''), () => '');
  return `The feedback server refused it (${response.status}${detail ? `: ${detail}` : ''}).`;
}
export class Outbox {
  private entries: Entry[] = [];
  private listeners = new Set<() => void>();
  private sentListeners = new Set<() => void>();
  private snapshot = EMPTY;
  private persistent = true;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private active = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = 0;
  constructor(public endpoint: string, private store: OutboxStore) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  onSent = (listener: () => void) => { this.sentListeners.add(listener); return () => { this.sentListeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  /** Resend what is left from before, and flush again when the network or the tab comes back. */
  start() {
    this.active = true;
    window.addEventListener('online', this.flush); window.addEventListener('focus', this.flush);
    this.loading ??= this.load();
    void this.loading.then(() => this.pump());
  }
  stop() {
    this.active = false; clearTimeout(this.timer);
    window.removeEventListener('online', this.flush); window.removeEventListener('focus', this.flush);
  }
  enqueue(job: OutboxJob) {
    const fallback = job.build(null), ready = !(job.capture instanceof Promise);
    const entry: Entry = { id: job.id, seq: this.next(), label: job.label, text: job.text, state: 'queued', fallback, body: ready ? job.build(job.capture as Capture) : null, sending: false, attempts: 0, nextAt: 0 };
    this.entries.push(entry);
    this.save(entry);
    if (!ready) {
      const settle = (body: Body) => { entry.pending = undefined; entry.body = body; this.save(entry); this.emit(); void this.pump(); };
      entry.pending = (job.capture as Promise<Capture>).then(shot => settle(job.build(shot)), () => settle(fallback));
    }
    this.emit(); void this.pump();
  }
  /** Skip the backoff wait: the network or the tab just came back. */
  flush = () => { for (const entry of this.entries) entry.nextAt = 0; void this.pump(); };
  retry(id: string) {
    const entry = this.entries.find(item => item.id === id && item.state === 'failed');
    if (!entry) return;
    entry.state = 'queued'; entry.reason = undefined; entry.attempts = 0; entry.nextAt = 0;
    this.save(entry); this.emit(); void this.pump();
  }
  /** A stuck item (picture too big, slow uplink): send its text alone, with the no-picture note. */
  sendWithoutPicture(id: string) {
    const entry = this.entries.find(item => item.id === id && !item.sending && !item.pending);
    if (!entry) return;
    entry.body = entry.fallback; entry.state = 'queued'; entry.reason = undefined; entry.attempts = 0; entry.nextAt = 0;
    this.save(entry); this.emit(); void this.pump();
  }
  discard(id: string) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    this.entries = this.entries.filter(item => item !== entry);
    void this.store.remove(id).catch(() => {}); this.emit();
  }
  private next() { this.last = Math.max(Date.now(), this.last + 1); return this.last; }
  private save(entry: Entry) {
    if (!this.entries.includes(entry)) return; // discarded while a send was in flight
    const { id, seq, label, text, body, fallback, state, reason } = entry;
    void this.store.put({ id, seq, label, text, body, fallback, state, ...(reason ? { reason } : {}) }).catch(() => {});
  }
  private async load() {
    this.persistent = await this.store.ready;
    const records = await this.store.load().catch(() => []);
    const known = new Set(this.entries.map(entry => entry.id));
    // A record with no body is a capture a reload cut short: it goes as text, with the no-picture note.
    for (const record of records) if (!known.has(record.id)) this.entries.push({ ...record, body: record.body ?? record.fallback, sending: false, attempts: 0, nextAt: 0 });
    this.entries.sort((a, b) => a.seq - b.seq);
    this.loaded = true; this.emit();
  }
  private emit() {
    const items = this.entries.map((entry): OutboxView => ({ id: entry.id, label: entry.label, text: entry.text, reason: entry.reason, attempts: entry.attempts, stuck: entry.state !== 'failed' && entry.attempts >= STUCK_AFTER, status: statusOf(entry) }));
    const failed = items.filter(item => item.status === 'failed').length;
    this.snapshot = { items, failed, pending: items.length - failed, persistent: this.persistent };
    for (const listener of this.listeners) listener();
  }
  private async pump() {
    if (this.running || !this.active || !this.loaded) return;
    this.running = true;
    try {
      while (this.active) {
        const entry = this.nextDue();
        if (!entry) return;
        await this.send(entry);
      }
    } finally { this.running = false; }
  }
  /** The first item to send now. A waiting item holds the ones behind it (to keep order) until it is stuck. */
  private nextDue(): Entry | null {
    let soonest = Infinity;
    for (const entry of this.entries) {
      if (entry.state === 'failed') continue;
      if (entry.pending) return null;
      const wait = entry.nextAt - Date.now();
      if (wait <= 0) return entry;
      soonest = Math.min(soonest, entry.nextAt);
      if (entry.attempts < STUCK_AFTER) break;
    }
    if (soonest < Infinity) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.pump(); }, Math.max(0, soonest - Date.now())); }
    return null;
  }
  private async send(entry: Entry) {
    entry.sending = true; this.emit();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT);
    try {
      const response = await fetch(`${this.endpoint}/api/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ ...(entry.body ?? entry.fallback), client_id: entry.id }) });
      if (response.ok) { this.done(entry); return; }
      if (response.status < 500 && !RETRY_STATUS.has(response.status)) { await this.fail(entry, response); return; }
      this.wait(entry);
    } catch { this.wait(entry); }
    finally { clearTimeout(timeout); entry.sending = false; this.emit(); }
  }
  private done(entry: Entry) {
    this.entries = this.entries.filter(item => item !== entry);
    void this.store.remove(entry.id).catch(() => {});
    for (const listener of this.sentListeners) listener();
  }
  private async fail(entry: Entry, response: Response) {
    entry.state = 'failed'; entry.reason = await refusal(response); this.save(entry);
  }
  private wait(entry: Entry) {
    entry.nextAt = Date.now() + BACKOFF[Math.min(entry.attempts, BACKOFF.length - 1)]!;
    entry.attempts++;
    if (entry.attempts === STUCK_AFTER) { this.entries = this.entries.filter(item => item !== entry); this.entries.push(entry); }
  }
}
function statusOf(entry: Entry): OutboxStatus {
  if (entry.state === 'failed') return 'failed';
  if (entry.sending) return 'sending';
  if (entry.pending) return 'capturing';
  return entry.attempts > 0 ? 'retrying' : 'queued';
}
export function newId() {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
