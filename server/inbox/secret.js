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
