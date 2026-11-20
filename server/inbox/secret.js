// The key box, the part that needs no DOM. A key goes from the browser straight to the app's own key store, never to this server.

// The URL to send a key to: the configured template with {name} filled in, or null when it is not a plain path on this site.
// Absolute, protocol-relative and backslash forms are refused, so a bad config can never send a key to another origin.
export function secretUrl(template, name, origin) {
  if (typeof template !== 'string' || typeof name !== 'string' || !name) return null;
  if (!/^\/(?!\/)[A-Za-z0-9/_.~%-]*\{name\}[A-Za-z0-9/_.~%-]*$/.test(template) || template.split('/').includes('..')) return null;
  const path = template.replace('{name}', encodeURIComponent(name));
  try { return new URL(path, origin).origin === new URL(origin).origin && path.startsWith('/') && !path.startsWith('//') ? path : null; } catch { return null; }
}
// "Saved ✓ · ends …abcd" once a key is saved; when the app tried it and the provider turned it down, say so instead of a tick.
export const secretStatusLine = secret => `${secret?.check === 'rejected' ? 'Saved, but the provider rejected it' : 'Saved ✓'}${secret?.hint ? ` · ends ${secret.hint}` : ''}`;

const BUCKET = 64;
// The ciphertext is a multiple of 64 bytes (plus the GCM tag), so its length does not reveal the secret's length.
// Byte 0 is version 1, the next three are the plaintext length, and the rest of the bucket is zeros.
// A link from before this (anything that is not that shape) is the raw plaintext and still opens.
export function padSecret(text) {
  const plain = new TextEncoder().encode(text);
  if (plain.length > 0xffffff) throw new Error('secret is too long');
  const need = 4 + plain.length;
  let size = Math.ceil(need / BUCKET) * BUCKET;
  if (size === need) size += BUCKET;
  const out = new Uint8Array(size);
  out[0] = 1;
  out[1] = (plain.length >>> 16) & 255;
  out[2] = (plain.length >>> 8) & 255;
  out[3] = plain.length & 255;
  out.set(plain, 4);
  return out;
}
export function unpadSecret(bytes) {
  if (!bytes || bytes.length < BUCKET || bytes.length % BUCKET !== 0 || bytes[0] !== 1) return bytes;
  const len = ((bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (len > bytes.length - 4) return bytes;
  for (let i = 4 + len; i < bytes.length; i++) if (bytes[i] !== 0) return bytes;
  return bytes.subarray(4, 4 + len);
}
