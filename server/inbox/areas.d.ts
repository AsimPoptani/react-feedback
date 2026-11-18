export const CONVERSATIONS: string;
export const HOME: string;
export function areaLabel(key: string): string;
export function areaOf(t: { mode?: string; url?: string | null }): { area: string };
export function sortAreas(keys: string[]): string[];
