// Where a React element came from: the nearest component with source info (file, line, column) and the component names above it.
// Adapted from Local Browser Bridge (MIT), copyright 2026 Local Browser Bridge contributors: the in-page fiber walking of its
// `reactInspect` helper (fiber lookup, display names, `_debugSource`, `_debugStack` parsing, the ancestor fallback). Only that walk
// is used here; none of its debugger, extension or bridge code. The licence text is in THIRD_PARTY_NOTICES.md.
//
// React 18 and earlier keep `_debugSource` ({ fileName, lineNumber, columnNumber }) on a fiber when a JSX source plugin is on.
// React 19 keeps `_debugStack` (an Error created where the element was made) in development builds.
// Coordinates taken from a stack are the ones the browser saw (the bundled file), so they are marked `runtime` and are not source-mapped.
// A production build usually has neither: the result is then the component names only, or nothing.

export interface SourceLocation { file: string; line: number; column: number; component: string; runtime?: true; ancestor?: true }
export interface ReactSource { source?: SourceLocation; components: string[] }

interface Fiber {
  type?: unknown; elementType?: unknown; tag?: number; return?: Fiber | null; alternate?: Fiber | null;
  _debugSource?: { fileName?: unknown; lineNumber?: unknown; columnNumber?: unknown } | null; _debugStack?: { stack?: unknown } | null;
}
interface Frame { name: string | null; file: string; line: number; column: number }
interface Found { file: string; line: number; column: number; name: string | null; runtime: boolean }

export const MAX_COMPONENTS = 40;
const MAX_WALK = 200;
const MAX_FRAMES = 12;

const fiberOf = (element: Element): Fiber | undefined => {
  const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
  return key ? (element as unknown as Record<string, Fiber>)[key] : undefined;
};
const clean = (value: string, max: number): string => {
  let out = '';
  for (const ch of value) { const code = ch.charCodeAt(0); if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) out += ch; }
  return out.slice(0, max);
};
const displayName = (fiber: Fiber): string | null => {
  const type = (fiber.type || fiber.elementType) as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | string | undefined;
  if (typeof type === 'string') return null; // a DOM element, not a component
  if (!type) return null;
  const inner = type.render || type.type;
  const name = type.displayName || type.name || inner?.displayName || inner?.name;
  return typeof name === 'string' && name ? clean(name, 100) : null;
};
const fileName = (value: string): string => {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    return clean(url.protocol === 'http:' || url.protocol === 'https:' ? path.replace(/^\//, '') : path, 300);
  } catch { return clean(value.replace(/[?#].*$/, ''), 300); }
};
const direct = (fiber: Fiber): Found | null => {
  const source = fiber._debugSource || fiber.alternate?._debugSource;
  if (!source || typeof source.fileName !== 'string' || !source.fileName) return null;
  return { file: fileName(source.fileName), line: Number.isInteger(source.lineNumber) ? source.lineNumber as number : 0, column: Number.isInteger(source.columnNumber) ? source.columnNumber as number : 0, name: null, runtime: false };
};
const FRAME = /^(?:at (.*?) \((.+):(\d+):(\d+)\)|at (.+):(\d+):(\d+)|(.*?)@(.+):(\d+):(\d+))$/;
const frames = (stack: unknown): Frame[] => {
  if (typeof stack !== 'string') return [];
  const out: Frame[] = [];
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line.trim());
    if (!match) continue;
    const file = fileName(match[2] || match[5] || match[9] || '');
    if (!file || /(^|\/)node_modules\/|^node:|^<anonymous>/.test(file)) continue; // React and other packages are never where the element was written
    out.push({ name: clean(match[1] || match[8] || '', 100) || null, file, line: Number(match[3] || match[6] || match[10]), column: Number(match[4] || match[7] || match[11]) });
    if (out.length === MAX_FRAMES) break;
  }
  return out;
};
const fromStack = (fiber: Fiber): Found | null => {
  const frame = frames(fiber._debugStack?.stack)[0] ?? frames(fiber.alternate?._debugStack?.stack)[0];
  return frame ? { file: frame.file, line: frame.line, column: frame.column, name: frame.name, runtime: true } : null;
};
const found = (fiber: Fiber): Found | null => direct(fiber) ?? fromStack(fiber);
const nearestName = (fiber: Fiber | null | undefined): string => {
  for (let at = fiber, hops = 0; at && hops < MAX_WALK; at = at.return, hops++) { const name = displayName(at); if (name) return name; }
  return '';
};

// The component names from the element's fiber up (innermost first, at most 40), and the nearest source location.
// The element's own location comes first; failing that, the nearest ancestor that has one (marked `ancestor`).
export function reactSource(element: Element): ReactSource {
  const start = fiberOf(element);
  if (!start) return { components: [] };
  const components: string[] = [];
  const seen = new Set<Fiber>();
  for (let fiber: Fiber | null | undefined = start; fiber && seen.size < MAX_WALK && components.length < MAX_COMPONENTS; fiber = fiber.return) {
    if (seen.has(fiber)) break;
    seen.add(fiber);
    const name = displayName(fiber);
    if (name) components.push(name);
  }
  let hit = found(start), ancestor = false;
  if (!hit) {
    const walked = new Set<Fiber>();
    for (let parent = start.return; parent && walked.size < MAX_WALK; parent = parent.return) {
      if (walked.has(parent)) break;
      walked.add(parent);
      hit = found(parent);
      if (hit) { ancestor = true; if (!hit.name) hit.name = displayName(parent); break; }
    }
  }
  if (!hit) return { components };
  const component = hit.name || nearestName(start) || components[0] || '';
  return { components, source: { file: hit.file, line: hit.line, column: hit.column, component, ...(hit.runtime ? { runtime: true as const } : {}), ...(ancestor ? { ancestor: true as const } : {}) } };
}
