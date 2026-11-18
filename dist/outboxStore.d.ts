/** One queued note. `body` is null while its picture is still being taken; `fallback` is the text-only version. */
export interface OutboxRecord {
    id: string;
    seq: number;
    label: string;
    text: string;
    body: Record<string, unknown> | null;
    fallback: Record<string, unknown>;
    state: 'queued' | 'failed';
    reason?: string;
}
export interface OutboxStore {
    /** Resolves true when records survive a reload, false when this browser only allows memory. */
    ready: Promise<boolean>;
    load: () => Promise<OutboxRecord[]>;
    put: (record: OutboxRecord) => Promise<void>;
    remove: (id: string) => Promise<void>;
}
/** IndexedDB holds the queue (the items can be several MB of data URLs); with no IndexedDB, a Map does. */
export declare function openStore(): OutboxStore;
