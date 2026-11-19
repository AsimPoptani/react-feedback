export interface PresenceData { user: { at: string } | null; agents: { name: string | null; at: string }[] }
export interface PresenceLine { who: 'agent' | 'user'; name: string; at: string; text: string }
export function relative(iso: string, now: number): string;
export function whenText(iso: string, now: number, clock: (iso: string, now: number) => string): string;
export function presenceLines(presence: PresenceData | null | undefined, now: number, options: { agentName?: string; clock: (iso: string, now: number) => string }): PresenceLine[];
