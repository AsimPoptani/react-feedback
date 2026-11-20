// Puts the capture widget on any local dev server without touching its code: a proxy that injects embed.js into its HTML,
// sends /__feedback to the feedback server, and passes everything else through (WebSockets too, so Vite's hot reload keeps working).
import type { Server, ServerWebSocket } from 'bun';

interface Pipe { url: string; protocols: string[]; up?: WebSocket; queue: (string | ArrayBuffer | Uint8Array)[] }
const PREFIX = '/__feedback';
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding'];

export function injectWidget(html: string, position?: string): string {
  const tag = `<script src="${PREFIX}/embed.js" data-endpoint="${PREFIX}"${position ? ` data-position="${position}"` : ''}></script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}</body>`) : `${html}${tag}`;
}

// The proxy has no sign-in, and what is written through it can drive a Claude Code session: it listens on this machine only. Any other address needs
// --unsafe-public, which says in its name what it risks.
export const isLoopback = (host: string) => /^(localhost|\[?::1\]?|127(\.\d{1,3}){3})$/i.test(host.trim());
export function bindHost(host: string | undefined, unsafePublic = false): string {
  const wanted = host?.trim() || '127.0.0.1';
  if (!isLoopback(wanted) && !unsafePublic) throw new Error(`Refusing to listen on ${wanted}: the proxy has no sign-in and only listens on this machine (127.0.0.1). Pass --unsafe-public if you really mean to expose it.`);
  return wanted;
}

export function proxyOptions(target: string, port: number, feedback: string, position?: string, host = '127.0.0.1') {
  const app = new URL(target), inbox = new URL(feedback);
  if (!/^https?:$/.test(app.protocol)) throw new Error('The target must be an http(s) URL, for example http://localhost:5391');
  return {
    port, hostname: host,
    async fetch(req: Request, server: Server<Pipe>): Promise<Response | undefined> {
      const url = new URL(req.url);
      const base = url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`) ? inbox : app;
      const dest = new URL(url.pathname + url.search, base);
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(p => p.trim()).filter(Boolean);
        dest.protocol = dest.protocol === 'https:' ? 'wss:' : 'ws:';
        const data: Pipe = { url: dest.href, protocols, queue: [] };
        if (server.upgrade(req, { data, headers: protocols[0] ? { 'Sec-WebSocket-Protocol': protocols[0] } : undefined })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      const headers = new Headers(req.headers);
      headers.set('host', base.host);
      headers.set('accept-encoding', 'identity'); // the HTML is rewritten, so it must arrive uncompressed
      const res = await fetch(dest, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body, redirect: 'manual', decompress: false } as RequestInit);
      const out = new Headers(res.headers);
      for (const h of HOP) out.delete(h);
      if (base === app && (res.headers.get('content-type') ?? '').includes('text/html')) return new Response(injectWidget(await res.text(), position), { status: res.status, statusText: res.statusText, headers: out });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    },
    websocket: {
      open(ws: ServerWebSocket<Pipe>) {
        const up = new WebSocket(ws.data.url, ws.data.protocols);
        up.binaryType = 'arraybuffer';
        ws.data.up = up;
        up.onopen = () => { for (const m of ws.data.queue) up.send(m); ws.data.queue = []; };
        up.onmessage = e => ws.send(e.data as string | ArrayBuffer);
        up.onclose = e => ws.close(e.code >= 1000 && e.code < 5000 && e.code !== 1005 && e.code !== 1006 ? e.code : 1000, e.reason);
        up.onerror = () => ws.close(1011, 'upstream error');
      },
      message(ws: ServerWebSocket<Pipe>, message: string | Buffer) {
        if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(message); else ws.data.queue.push(message);
      },
      close(ws: ServerWebSocket<Pipe>) { ws.data.up?.close(); },
    },
  };
}
