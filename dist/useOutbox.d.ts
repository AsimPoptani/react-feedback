import type { Outbox, OutboxSnapshot } from './outboxQueue.js';
export declare const OutboxContext: import("react").Context<Outbox | null>;
export declare function useOutbox(): Outbox | null;
export declare function useOutboxSnapshot(): OutboxSnapshot;
