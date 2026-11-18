interface LogEntry { level: 'warn' | 'error'; message: string }
interface FailedFetch { method: string; url: string; status?: number; error?: string }
interface Capture { console: LogEntry[]; failedFetches: FailedFetch[] }
const KEY = Symbol.for('standalone.feedback.capture');
// Guarded so that importing the package on a server (SSR) does not throw; the capture is only installed in the browser.
const host = (typeof window === 'undefined' ? {} : window) as Window & { [KEY]?: Capture };
export function cleanUrl(raw: string): string {
  try { const url = new URL(raw, location.href); return `${url.origin}${url.pathname}`; }
  catch { return raw.split(/[?#]/)[0] ?? ''; }
}
function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return '[unserializable]'; }
}
function push<T>(values: T[], value: T, limit: number) { values.push(value); if (values.length > limit) values.shift(); }
export function installCapture(): Capture {
  if (host[KEY]) return host[KEY];
  const capture: Capture = { console: [], failedFetches: [] };
  host[KEY] = capture;
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(capture.console, { level, message: args.map(describe).join(' ').slice(0, 300) }, 30);
      original(...args);
    };
  }
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const info = { method: (init?.method ?? request?.method ?? 'GET').toUpperCase(), url: cleanUrl(request?.url ?? String(input)) };
    try {
      const response = await original(input, init);
      if (!response.ok) push(capture.failedFetches, { ...info, status: response.status }, 20);
      return response; // Do not read/clone bodies: streamed Ask responses pass through intact.
    } catch (error) {
      push(capture.failedFetches, { ...info, error: error instanceof Error ? error.name : 'Error' }, 20);
      throw error;
    }
  };
  return capture;
}
export function getContext() {
  const capture = installCapture();
  return {
    url: location.href, title: document.title, route: location.pathname + location.search,
    viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY },
    devicePixelRatio, userAgent: navigator.userAgent,
    'prefers-color-scheme': matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    ts: new Date().toISOString(), console: [...capture.console], failedFetches: [...capture.failedFetches],
  };
}
