// Side questions ("/btw"), the part that needs no DOM. Shared by the server (waiting logic) and the inbox page.
// An aside is a message with `aside: true`. Its answers are aside messages whose `reply_to` is the aside's id.
export const isAside = m => m?.aside === true;
export const mainMessages = messages => messages.filter(m => !isAside(m));
// The user's side question: a root aside (no quote) from the user.
export const isAsideRoot = m => isAside(m) && m.author === 'user' && !m.divider && !m.reply_to;

// `/btw text` (case-insensitive) is a side question; the prefix is stripped. A bare `/btw` is one with no text yet.
export function parseBtw(text) {
  const m = /^\s*\/btw(?=\s|$)\s*([\s\S]*)$/i.exec(String(text ?? ''));
  return m ? { aside: true, text: m[1] } : { aside: false, text: String(text ?? '') };
}

// Every aside with its answers, in thread order. An aside is answered when an agent aside quotes it, or when the agent
// acknowledged the user's latest message without replying (`ackedThrough`, a timestamp).
export function asideGroups(messages, ackedThrough = null) {
  const roots = messages.filter(isAsideRoot);
  return roots.map(root => {
    const answers = messages.filter(m => isAside(m) && m.author === 'agent' && m.reply_to === root.id);
    const acked = !!ackedThrough && root.created_at <= ackedThrough;
    return { root, answers, answered: answers.length > 0 || acked };
  });
}
export const pendingAsides = (messages, ackedThrough = null) => asideGroups(messages, ackedThrough).filter(g => !g.answered).map(g => g.root);
