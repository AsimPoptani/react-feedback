export interface AreaRule { key: string; label: string; match: string; exact?: true; sub?: number }
export interface AreasConfig { readonly areas: readonly AreaRule[]; readonly conversations: string }
export const CONVERSATIONS: string;
export const HOME: string;
export const KEY: RegExp;
export const DEFAULT_AREAS: AreasConfig;
export function parseAreas(raw: unknown): AreasConfig;
export function areaLabel(key: string, config?: AreasConfig): string;
export function areaOf(t: { mode?: string; url?: string | null }, config?: AreasConfig): { area: string };
export function sortAreas(keys: string[], config?: AreasConfig): string[];
