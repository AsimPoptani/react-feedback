import { firstPlainLine } from './markdown.js';
// Quote replies, the part that needs no DOM: what a quote says, and what counts as a swipe-to-reply.
export const SNIPPET_MAX = 120;
export const SWIPE_MIN = 56; // px to the right
export const SWIPE_SLACK = 32; // px up or down before it counts as a scroll instead

// The first non-blank line of a message, cut short; "Image" when it is only a picture.
export function snippetOf(message) {
  if (message.redacted) return '🔒 Redacted';
  const line = firstPlainLine(message.text ?? '');
  if (line) return line.slice(0, SNIPPET_MAX);
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

// ---- Quoting a bit of a message: select text in a message, and the composer gets it as a quote block.
export const QUOTE_MAX = 1000;
const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
// The selection as a markdown quote block: every line behind a `> `.
export const quoteBlock = text => String(text ?? '').split('\n').map(line => (line.trim() ? `> ${line}` : '>')).join('\n');
// The composer text with the quote block in it: what was already typed, then the block, then the note, ready to type after.
export function withQuote(current, text, note = '') {
  const before = String(current ?? '').replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${quoteBlock(text)}\n\n${String(note ?? '').trim()}`;
}
// A message's text split into its leading quote block and the rest. `matched` is true only when that block says what the quote says (spacing aside).
export function splitQuoteBlock(text, quote) {
  const lines = String(text ?? '').split('\n');
  const got = [];
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) { got.push(lines[i].replace(/^>\s?/, '')); i++; }
  if (!got.length || !quote || flat(got.join('\n')) !== flat(quote.text)) return { matched: false, rest: String(text ?? '') };
  while (i < lines.length && !lines[i].trim()) i++;
  return { matched: true, rest: lines.slice(i).join('\n') };
}
// The quote to send with a message: it counts only while its block is still at the top of the text (a person who deleted the block no longer quotes).
export function activeQuote(quote, text) {
  if (!quote?.message_id || !flat(quote.text)) return null;
  return splitQuoteBlock(text, quote).matched ? { message_id: quote.message_id, text: String(quote.text).slice(0, QUOTE_MAX) } : null;
}
// What to show of a stored message that carries a quote: its text without the quote block (the quote is drawn on its own above it).
export const shownText = message => (message.quote?.message_id ? splitQuoteBlock(message.text, message.quote).rest : message.text);
// "src/ui/Card.tsx" stays as it is; a long path keeps its first folder and its last two parts: "src/…/ui/Card.tsx".
export function shortPath(file, max = 40) {
  const path = String(file ?? '');
  if (path.length <= max) return path;
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return `…${path.slice(-(max - 1))}`;
  return `${path.startsWith('/') ? '/' : ''}${parts[0]}/…/${parts.slice(-2).join('/')}`;
}
export const sourceLabel = source => `${source.file}${source.line ? `:${source.line}${source.column ? `:${source.column}` : ''}` : ''}`;
export const shortSource = source => `${shortPath(source.file)}${source.line ? `:${source.line}` : ''}`;
