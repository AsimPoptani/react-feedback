// "Last seen" for the page header and the CLI: under an hour it is relative ("2 min ago"), after that the time.
// Shared by the inbox (local time) and the CLI (UTC), so the wording lives in one place.
export function relative(iso, now) {
  const age = Math.max(0, now - Date.parse(iso));
  if (age < 30e3) return 'just now';
  return `${Math.min(59, Math.max(1, Math.round(age / 60e3)))} min ago`;
}
// `clock(iso, now)` formats the time after an hour in the viewer's zone (the inbox) or UTC (the CLI).
export function whenText(iso, now, clock) { return now - Date.parse(iso) < 3600e3 ? relative(iso, now) : clock(iso, now); }
// Each viewer sees the other side only: the user sees the agents; an agent sees the user and the other agents (not itself, matched by name; null is the unnamed one).
export function forViewer(presence, viewer) {
  if (!presence) return null;
  if (viewer === 'user') return { user: null, agents: presence.agents || [] };
  return { user: presence.user || null, agents: (presence.agents || []).filter(a => (a.name || null) !== (viewer.agent || null)) };
}
// The lines to show: each agent ("Claude · active 2 min ago") then the user ("You · last seen 10:42"). Nothing when there is no data.
export function presenceLines(presence, now, { agentName = 'Agent', clock, viewer }) {
  const seen = viewer ? forViewer(presence, viewer) : presence;
  if (!seen) return [];
  const lines = (seen.agents || []).slice(0, 3).map(a => ({ who: 'agent', name: a.name || agentName, at: a.at, text: `${a.name || agentName} · active ${whenText(a.at, now, clock)}` }));
  if (seen.user) lines.push({ who: 'user', name: 'You', at: seen.user.at, text: `You · last seen ${whenText(seen.user.at, now, clock)}` });
  return lines;
}
