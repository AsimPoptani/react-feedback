import { useEffect, useState } from 'react';
import { Keycap } from './Keycap.js';
import { Outbox } from './OutboxList.js';
import type { FeedbackItem } from './types.js';
export function FeedbackList({ endpoint, onClose }: { endpoint: string; onClose: () => void }) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (revision > 0) setItems([]);
    const controller = new AbortController(); setLoading(true); setError('');
    fetch(`${endpoint}/api/items`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Could not load feedback.');
      const data = await response.json() as FeedbackItem[];
      if (!controller.signal.aborted) setItems(data.sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load feedback. Check the feedback server and try Refresh.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, revision]);
  return <section className="fb-panel" aria-label="My feedback">
    <header><h2>My feedback</h2><button type="button" onClick={onClose} aria-keyshortcuts="Escape">Close <Keycap>Esc</Keycap></button></header>
    <Outbox onSent={() => setRevision(previous => previous + 1)} />
    <a href={`${endpoint}/inbox/`} target="_blank" rel="noopener noreferrer">Open inbox</a>{' '}
    <button type="button" onClick={() => setRevision(previous => previous + 1)}>Refresh</button>
    {loading && <p role="status">Loading…</p>}{error && <p role="alert">{error}</p>}
    {!loading && !items.length && !error && <p>No feedback yet.</p>}
    {items.map(item => <details key={item.id} className="fb-item">
      <summary><strong>{item.id}</strong> · <a href={`${endpoint}/inbox/#/${item.id}`} target="_blank" rel="noopener noreferrer">Open thread</a><br /><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time> · {item.mode} · <span>{item.status}</span><p>{item.note_first_line}</p>{item.reply && <p>Reply: {item.reply.split('\n')[0]}</p>}</summary>
      {item.reply ? <div className="fb-reply">{item.reply}</div> : <p>No reply yet.</p>}
    </details>)}
  </section>;
}
