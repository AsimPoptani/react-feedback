import { useEffect } from 'react';
import { useOutbox, useOutboxSnapshot } from './useOutbox.js';
import type { OutboxStatus } from './outboxQueue.js';
const WORDS: Record<OutboxStatus, string> = {
  capturing: 'Waiting for its picture', queued: 'Waiting to send', sending: 'Sending…',
  retrying: 'Could not reach the feedback server. Waiting to retry', failed: 'Failed',
};
/** Notes saved but not yet delivered. Sent notes leave here and appear in the list. */
export function Outbox({ onSent }: { onSent?: () => void }) {
  const outbox = useOutbox(), { items, persistent } = useOutboxSnapshot();
  useEffect(() => (onSent && outbox ? outbox.onSent(onSent) : undefined), [outbox, onSent]);
  if (!outbox || !items.length) return null;
  return <section className="fb-outbox" aria-label="Outbox">
    <h3>Outbox</h3>
    {!persistent && <p className="fb-hint">This browser can't keep unsent notes across a reload, so they are held in memory only.</p>}
    <ul>{items.map(item => <li key={item.id} data-status={item.stuck ? 'stuck' : item.status}>
      <strong>{item.label}</strong>
      <span>{item.status === 'failed' && item.reason ? `${WORDS.failed}: ${item.reason}` : item.stuck ? `Still can't send it after ${item.attempts} tries. The other notes are going ahead of it` : WORDS[item.status]}</span>
      {(item.status === 'failed' || item.stuck) && <pre className="fb-outbox-note" data-testid="outbox-note">{item.text}</pre>}
      {(item.status === 'failed' || item.stuck) && <span className="fb-outbox-actions">
        {item.status === 'failed' ? <button type="button" onClick={() => outbox.retry(item.id)}>Retry</button> : <button type="button" onClick={() => outbox.sendWithoutPicture(item.id)}>Send without picture</button>}
        <button type="button" onClick={() => outbox.discard(item.id)}>Discard</button>
      </span>}
    </li>)}</ul>
  </section>;
}
