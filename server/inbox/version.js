// The open page's version against the one the server is running now. They differ after a redeploy, until this tab loads the new shell.
// Dismissing remembers that server version and no other, so the next one asks again.
export const DISMISS_KEY = 'fb-inbox-update-dismissed';
const PLAIN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,40}$/;

// The server version to offer, or null when the banner stays hidden.
export function offeredVersion(loaded, server, dismissed) {
  if (typeof loaded !== 'string' || !PLAIN.test(loaded)) return null;
  if (typeof server !== 'string' || !PLAIN.test(server)) return null;
  if (server === loaded) return null;
  if (dismissed === server) return null;
  return server;
}

export function updateBannerText(version) {
  return `A new version (v${String(version).replace(/^v/, '')}) is ready. Reload to update`;
}
