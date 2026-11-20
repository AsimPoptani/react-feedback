export function durationText(ms: number): string;
export function replaySummary(meta: { duration_ms: number; clicks: number; version: number | null }): string;
export function heatPositions(clicks: { x: number; y: number }[], width: number, height?: number): { left: number; top: number }[];
export function newSessionId(): string;
