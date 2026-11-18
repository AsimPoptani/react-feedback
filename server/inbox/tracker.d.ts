import type { ChecklistItem } from '../store';
export interface TrackerRow { thread: string; title: string; read_only: boolean; item: ChecklistItem }
export interface TrackerGroups<R> { you: R[]; agent: R[]; done_recent: R[] }
export const RECENT_MS: number;
export const STATES: string[];
export function stateOf(item: ChecklistItem): 'open' | 'claimed' | 'done';
export function filterRows<R extends { thread: string; item: ChecklistItem }>(rows: R[], f?: { thread?: string; state?: string; q?: string }): R[];
export function groupRows<R extends { item: ChecklistItem }>(rows: R[], now?: number): TrackerGroups<R>;
export function ageOf(iso: string, now?: number): string;
