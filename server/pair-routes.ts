// The routes the inbox uses to pair a phone and to manage paired devices. They are served by the ordinary handler, so they exist on the local listener (unchanged trust: whoever
// reaches it is the user) and, behind the remote listener's device check, for an already-paired device. Pairing itself (the exchange) lives only on the remote listener.
import { CODE_TTL_MS, DEVICE_ID, type Pairing } from './pair';

export type ExtraRoute = (req: Request, path: string) => Promise<Response | null>;
// The remote wrapper sets these on the request it hands inward (after deleting any the caller sent). A caller of the local listener could set them too, which gains nothing.
export const REMOTE_HEADER = 'x-rf-remote';
export const DEVICE_HEADER = 'x-rf-device';

const PREFIX = '/__feedback/api';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// A write from a browser must come from this site. With no Origin header (curl, a script) there is nothing for a web page to forge. On the remote listener the wrapper has already
// checked the origin against the public URL, so this check stands down there.
function sameSite(req: Request): boolean {
  if (req.headers.get(REMOTE_HEADER) === '1') return true;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.get('host'); } catch { return false; }
}
async function jsonBody(req: Request): Promise<boolean> {
  if (!req.body) return true;
  const type = req.headers.get('content-type')?.split(';')[0]?.trim();
  return type === 'application/json';
}

export function pairRoutes(pairing: Pairing): ExtraRoute {
  return async (req, path) => {
    if (!path.startsWith(`${PREFIX}/pair/`) && !path.startsWith(`${PREFIX}/devices`)) return null;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      if (!sameSite(req)) return reply({ kind: 'forbidden', detail: 'Cross-site request refused' }, 403);
      if (!(await jsonBody(req))) return reply({ kind: 'invalid_request', detail: 'JSON only' }, 415);
    }
    if (path === `${PREFIX}/pair/status` && method === 'GET') {
      const { on, publicUrl, source } = pairing.remote;
      return reply({ remote: on, public_url: publicUrl, source, ttl_seconds: CODE_TTL_MS / 1000 });
    }
    if (path === `${PREFIX}/pair/codes` && method === 'POST') {
      if (!pairing.remote.on) return reply({ kind: 'remote_off', detail: 'Remote mode is off. Start the server with `react-feedback serve --remote`.' }, 409);
      return reply({ ...pairing.createCode(), ttl_seconds: CODE_TTL_MS / 1000 }, 201);
    }
    const code = path.match(/^\/__feedback\/api\/pair\/codes\/([0-9a-f]{8})$/);
    if (code && method === 'DELETE') return reply({ revoked: pairing.revokeCode(code[1]!) });
    if (path === `${PREFIX}/devices` && method === 'GET') {
      const current = req.headers.get(DEVICE_HEADER);
      return reply({ remote: pairing.remote.on, devices: (await pairing.list()).map(d => ({ ...d, ...(current === d.id ? { current: true } : {}) })) });
    }
    if (path === `${PREFIX}/devices/revoke-all` && method === 'POST') return reply({ revoked: await pairing.revokeAll() });
    const device = path.match(/^\/__feedback\/api\/devices\/([^/]+)$/);
    if (device && method === 'DELETE') {
      if (!DEVICE_ID.test(device[1]!)) return reply({ kind: 'not_found' }, 404);
      return (await pairing.revoke(device[1]!)) ? reply({ revoked: true }) : reply({ kind: 'not_found' }, 404);
    }
    return reply({ kind: 'not_found' }, 404);
  };
}
