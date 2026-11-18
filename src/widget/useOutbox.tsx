import { createContext, useContext, useSyncExternalStore } from 'react';
import { EMPTY } from './outboxQueue';
import type { Outbox, OutboxSnapshot } from './outboxQueue';
export const OutboxContext = createContext<Outbox | null>(null);
const none = () => () => {};
export function useOutbox(): Outbox | null { return useContext(OutboxContext); }
export function useOutboxSnapshot(): OutboxSnapshot {
  const outbox = useOutbox();
  return useSyncExternalStore(outbox?.subscribe ?? none, outbox?.getSnapshot ?? (() => EMPTY));
}
