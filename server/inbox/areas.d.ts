export interface AreaRule { key: string; label: string; match?: string; exact?: true; sub?: number; subHeading?: string; suffix?: string; prefix?: string }
export interface AreasConfig { readonly areas: readonly AreaRule[]; readonly conversations: string; readonly fallback?: { readonly key: string; readonly label: string }; readonly order?: readonly string[] }
export const CONVERSATIONS: string;
export const HOME: string;
export const KEY: RegExp;
export const DEFAULT_AREAS: AreasConfig;
export function parseAreas(raw: unknown): AreasConfig;
export function areaLabel(key: string, config?: AreasConfig): string;
export function areaOf(t: { mode?: string; url?: string | null }, config?: AreasConfig): { area: string; sub?: string };
export function subHeading(key: string, sub: string, config?: AreasConfig): string | null;
export function sortAreas(keys: string[], config?: AreasConfig): string[];
