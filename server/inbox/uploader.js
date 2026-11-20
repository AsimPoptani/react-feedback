// Uploads one file to the inbox's server in chunks of at most 32 MiB, resumable, with the file's sha256 checked at the end.
// A chunk never goes through memory twice: it is hashed from a slice and sent as the slice itself. No build, no deps.
import { createSha256 } from './sha256.js';
export const CHUNK = 32 * 1024 * 1024;
const BACKOFF = [1000, 3000, 8000, 20000];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class UploadError extends Error {
  constructor(message, { status = 0, network = false, cancelled = false } = {}) { super(message); this.status = status; this.network = network; this.cancelled = cancelled; }
}
// Sends one chunk and reports bytes as they go (XMLHttpRequest, the one browser API that reports upload progress). Resolves { status, body }; rejects with a network UploadError.
export function xhrPut(url, blob, { signal, onBytes }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const gone = () => reject(new UploadError('Cancelled', { cancelled: true }));
    if (signal?.aborted) { gone(); return; }
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onBytes?.(e.loaded); };
    xhr.onload = () => { let body = null; try { body = JSON.parse(xhr.responseText); } catch { /* no JSON */ } resolve({ status: xhr.status, body }); };
    xhr.onerror = xhr.ontimeout = () => reject(new UploadError("You're offline, or the server can't be reached.", { network: true }));
    xhr.onabort = gone;
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}
// `route(path)` makes a full URL (it carries the project). `put` and `fetch` can be replaced (tests). `onProgress(sentBytes, size)`.
// `uploadId` resumes a known upload. `onId(id)` is told the upload id as soon as there is one, so a caller can keep it for a later resume.
export async function uploadFile({ file, route, fetch: send = globalThis.fetch.bind(globalThis), put = xhrPut, onProgress = () => {}, onId = () => {}, signal, uploadId = null, chunk = CHUNK, backoff = BACKOFF, wait = sleep }) {
  const size = file.size;
  const call = async (path, init) => {
    try { return await send(route(path), { ...init, signal }); }
    catch (error) { if (signal?.aborted) throw new UploadError('Cancelled', { cancelled: true }); throw new UploadError("You're offline, or the server can't be reached.", { network: true, cause: error }); }
  };
  const fail = async (response, fallback) => {
    let detail = ''; try { detail = (await response.json()).detail || ''; } catch { /* not JSON */ }
    return new UploadError(detail || fallback, { status: response.status });
  };
  let id = uploadId, offset = 0;
  if (id) {
    const r = await call(`uploads/${id}`, {});
    if (r.ok) offset = (await r.json()).offset; else if (r.status === 404) id = null; else throw await fail(r, `Could not resume (${r.status})`);
  }
  if (!id) {
    const r = await call('uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, size }) });
    if (!r.ok) throw await fail(r, `The server refused the file (${r.status})`);
    ({ id } = await r.json()); offset = 0;
  }
  onId(id);
  const hash = createSha256();
  onProgress(offset, size);
  let tries = 0;
  for (let pos = 0; pos < size; pos += chunk) {
    const slice = file.slice(pos, Math.min(size, pos + chunk));
    hash.update(new Uint8Array(await slice.arrayBuffer()));
    while (offset < pos + slice.size) { // this chunk (or the rest of it, after a resume) still has to reach the server
      if (signal?.aborted) throw new UploadError('Cancelled', { cancelled: true });
      const from = Math.max(offset, pos);
      let result;
      try { result = await put(route(`uploads/${id}?offset=${from}`), from === pos ? slice : slice.slice(from - pos), { signal, onBytes: n => onProgress(Math.min(size, from + n), size) }); }
      catch (error) {
        if (error.cancelled || !error.network || tries >= backoff.length) throw error;
        await wait(backoff[tries++]);
        const r = await call(`uploads/${id}`, {}).catch(() => null); // where does the server think we are?
        if (r?.ok) offset = (await r.json()).offset;
        continue;
      }
      if (result.status === 200 && result.body && typeof result.body.offset === 'number') { offset = result.body.offset; tries = 0; onProgress(offset, size); continue; }
      if (result.status === 409) { const r = await call(`uploads/${id}`, {}); if (!r.ok) throw await fail(r, 'Could not resume'); offset = (await r.json()).offset; continue; }
      if (result.status >= 500 && result.status !== 507 && tries < backoff.length) { await wait(backoff[tries++]); const r = await call(`uploads/${id}`, {}).catch(() => null); if (r?.ok) offset = (await r.json()).offset; continue; }
      throw new UploadError(result.body?.detail || `The server refused the file (${result.status})`, { status: result.status });
    }
  }
  const done = await call(`uploads/${id}/finalise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sha256: hash.digest() }) });
  if (!done.ok) throw await fail(done, `The server could not finish the file (${done.status})`);
  const ready = await done.json();
  onProgress(size, size);
  return { id: ready.id, name: ready.name, size: ready.size };
}
export const cancelRemote = (route, id, send = globalThis.fetch.bind(globalThis)) => send(route(`uploads/${id}`), { method: 'DELETE' }).catch(() => undefined);
