// A new-topic nudge: when a message to a thread looks like a different subject, the inbox offers to send it as a new thread (the title filled in) before it goes. Never blocks: "Send here" always works.
const OPENERS = /^\s*(also|another thing|separately)\b[\s,:;.-]*/i;
const STOP = new Set(['about', 'after', 'again', 'also', 'been', 'before', 'being', 'could', 'does', 'doing', 'from', 'have', 'here', 'just', 'like', 'make', 'more', 'need', 'only', 'other', 'over', 'should', 'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'thread', 'very', 'want', 'were', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'your']);
const LONG_WORDS = 45;
const words = text => (String(text || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter(w => !STOP.has(w));

// A title for the new thread: the first sentence, with the opener ("Also, ...") taken off, at most 70 characters.
export function suggestTitle(text) {
  const body = String(text || '').replace(OPENERS, '').trim();
  const first = (body.split(/(?<=[.!?])\s|\n/)[0] || body).replace(/\s+/g, ' ').trim();
  const cut = first.length > 70 ? `${first.slice(0, 69).replace(/\s+\S*$/, '')}…` : first;
  return (cut.charAt(0).toUpperCase() + cut.slice(1)) || 'New topic';
}
// null (send it here), or { reason: 'opener' | 'unrelated', title }.
export function topicNudge(text, threadTitle) {
  const t = String(text || '');
  if (!t.trim() || /^\s*\/btw\b/i.test(t)) return null;
  if (OPENERS.test(t)) return { reason: 'opener', title: suggestTitle(t) };
  const body = words(t);
  if (body.length < LONG_WORDS - 15 || t.trim().split(/\s+/).length < LONG_WORDS) return null;
  const title = [...new Set(words(threadTitle))];
  if (!title.length) return null;
  const set = new Set(body);
  const shared = title.filter(w => set.has(w)).length;
  return shared === 0 || (title.length >= 3 && shared / title.length < 0.2) ? { reason: 'unrelated', title: suggestTitle(t) } : null;
}
