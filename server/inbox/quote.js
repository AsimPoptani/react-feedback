// Quote replies, the part that needs no DOM: what a quote says, and what counts as a swipe-to-reply.
export const SNIPPET_MAX = 120;
export const SWIPE_MIN = 56; // px to the right
export const SWIPE_SLACK = 32; // px up or down before it counts as a scroll instead

// The first non-blank line of a message, cut short; "Image" when it is only a picture.
export function snippetOf(message) {
  const line = String(message.text ?? '').split('\n').find(l => l.trim());
  if (line) return line.trim().slice(0, SNIPPET_MAX);
  return message.images && message.images.length ? 'Image' : '';
}
// What a message's quote points at: null (it quotes nothing), a found message, or an unavailable original (merged away or deleted).
export function resolveQuote(messages, message) {
  if (!message.reply_to) return null;
  const original = messages.find(m => m.id === message.reply_to && !m.divider);
  return original ? { found: true, original, snippet: snippetOf(original) } : { found: false, original: null, snippet: 'Original message unavailable' };
}
// A rightward drag that stayed mostly level.
export const isReplySwipe = (dx, dy) => dx >= SWIPE_MIN && Math.abs(dy) <= SWIPE_SLACK && dx > Math.abs(dy) * 1.5;
