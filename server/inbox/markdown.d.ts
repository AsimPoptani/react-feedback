export function markdown(text: string): HTMLElement;
export function inline<T extends Node = DocumentFragment>(text: string, parent?: T, depth?: number): T;
export function parseBlocks(lines: string[], parent: Node): void;
export function plainText(text: string): string;
export function firstPlainLine(text: string): string;
export function safeHref(url: string): boolean;
