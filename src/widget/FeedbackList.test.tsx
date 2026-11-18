import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FeedbackList } from './FeedbackList';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('links to the inbox, and each item to its own thread, in a new tab', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([{ id: '20261118-120000-abcd', created_at: '2026-11-18T12:00:00Z', url: 'http://local', mode: 'element', note_first_line: 'Spacing', status: 'new', reply: null }])));
  render(<FeedbackList endpoint="/__feedback" onClose={() => {}} />);
  const inbox = screen.getByRole('link', { name: 'Open inbox' });
  expect(inbox.getAttribute('href')).toBe('/__feedback/inbox/');
  expect(inbox.getAttribute('target')).toBe('_blank'); expect(inbox.getAttribute('rel')).toContain('noopener');
  const thread = await screen.findByRole('link', { name: 'Open thread' });
  expect(thread.getAttribute('href')).toBe('/__feedback/inbox/#/20261118-120000-abcd');
  expect(thread.getAttribute('target')).toBe('_blank');
});
