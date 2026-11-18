import type { Capture } from './types.js';
import type { OutboxStore } from './outboxStore.js';
type Body = Record<string, unknown>;
export type OutboxStatus = 'capturing' | 'queued' | 'sending' | 'retrying' | 'failed';
export interface OutboxView {
    id: string;
    label: string;
    text: string;
    status: OutboxStatus;
    reason?: string;
    attempts: number;
    stuck: boolean;
}
export interface OutboxSnapshot {
    items: OutboxView[];
    pending: number;
    failed: number;
    persistent: boolean;
}
export interface OutboxJob {
    id: string;
    label: string;
    text: string;
    /** The finished picture, or the capture still running. */
    capture: Capture | Promise<Capture>;
    /** Builds the request body from the picture, or from nothing when the capture failed. */
    build: (capture: Capture | null) => Body;
}
/** Retry waits in ms; after the last, every minute. */
/** After this many failed attempts an item stops blocking the ones behind it. */
export declare const STUCK_AFTER = 3;
export declare const BACKOFF: number[];
export declare const EMPTY: OutboxSnapshot;
export declare class Outbox {
    endpoint: string;
    private store;
    private entries;
    private listeners;
    private sentListeners;
    private snapshot;
    private persistent;
    private loading;
    private loaded;
    private active;
    private running;
    private timer;
    private last;
    constructor(endpoint: string, store: OutboxStore);
    subscribe: (listener: () => void) => () => void;
    onSent: (listener: () => void) => () => void;
    getSnapshot: () => OutboxSnapshot;
    /** Resend what is left from before, and flush again when the network or the tab comes back. */
    start(): void;
    stop(): void;
    enqueue(job: OutboxJob): void;
    /** Skip the backoff wait: the network or the tab just came back. */
    flush: () => void;
    retry(id: string): void;
    /** A stuck item (picture too big, slow uplink): send its text alone, with the no-picture note. */
    sendWithoutPicture(id: string): void;
    discard(id: string): void;
    private next;
    private save;
    private load;
    private emit;
    private pump;
    /** The first item to send now. A waiting item holds the ones behind it (to keep order) until it is stuck. */
    private nextDue;
    private send;
    private done;
    private fail;
    private wait;
}
export declare function newId(): `${string}-${string}-${string}-${string}-${string}`;
export {};
