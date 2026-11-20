interface AsideMessage { id: string; author: 'user' | 'agent' | 'viewer'; created_at: string; aside?: boolean; divider?: boolean; reply_to?: string }
export interface AsideGroup<M extends AsideMessage> { root: M; answers: M[]; answered: boolean }
export const isAside: (m: AsideMessage | undefined) => boolean;
export const isAsideRoot: (m: AsideMessage) => boolean;
export function mainMessages<M extends AsideMessage>(messages: M[]): M[];
export function parseBtw(text: unknown): { aside: boolean; text: string };
export function asideGroups<M extends AsideMessage>(messages: M[], ackedThrough?: string | null): AsideGroup<M>[];
export function pendingAsides<M extends AsideMessage>(messages: M[], ackedThrough?: string | null): M[];
