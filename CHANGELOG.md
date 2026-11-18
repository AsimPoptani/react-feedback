# Changelog

## 0.6.0

### Added
- **Side questions (`/btw`).** A message may carry `aside: true`; its answers are aside messages whose `reply_to` is the question. Type `/btw text`, press **B**, or use the **Side question** button. The inbox shows each one as a compact, collapsible bubble (collapsed once answered, a "Waiting for agent" pill until then). Main-flow waiting ignores asides; an unanswered aside makes `waiting` "agent" (unless the main flow waits on you) and adds `waiting_aside: true` to the summary. CLI: `reply <id> "text" --aside --to <aside-id>`; `list --waiting` and `read` show asides. `_events.jsonl` lines carry `aside: true`; a merge keeps and remaps the links.
- **Checklist items attached to replies.** `reply --todo "item" [--for agent|user]` and `--check c3` add and tick items as part of the message, which stores `added_items` and `ticked_items`. The inbox shows "Added to checklist" and "Ticked" lists in the bubble, each jumping to its row (`#/<thread>/c3` opens a thread on an item). Over HTTP a user message may carry `todo` and `for`; `check` is the agent's only.
- **Move messages.** `move <from> <msg-id>... --to <into>`: messages (and images, times, authors, `reply_to` links, attached items, questions with answers) go to another thread; a "Moved to" stub stays behind; both threads are locked and an interrupted move is retried by running it again. Logs a `move` event (with `author: "agent"`; the metrics ignore agent events).
- **Tracker.** `#/tracker` and `GET api/tracker` list every item across the threads, grouped For you, For the agent and Done recently, with a donut, filters and search; CLI `tracker [--mine|--claimed|--open]`.
- **Markdown in message bodies.** Headings, tables, nested and ordered lists, task lists, blockquotes, rules, code, links (https, mailto, in-app), bold, italic, strikethrough, line breaks; no HTML is ever parsed. Snippets, previews and the tracker show plain text.

### Fixed
- Markdown: quotes and lists nested more than 8 levels deep are shown as plain text, so a message of thousands of `>` can no longer overflow the stack and stop a thread from opening. Unmatched emphasis, stray brackets and backticks, long space runs and blank-line runs are now linear-time.
- `move` into a thread the agent had already acknowledged no longer hides an unanswered user message (or side question) from the agent's queue.
- Merging a thread keeps what the agent (and the user) had already read in it, so ticks carry over, without marking an unread message of the target as read. An agent checklist change marks the thread read for the agent, as a reply does.

### Changed
- Links in messages: only https, mailto and in-app `#/` links are made links (plain `http://` links are shown as text).
- A single line break in a message is a `<br>` instead of a preserved newline; lines that look like a Markdown list, table or heading now render as one.

## 0.5.0

### Added
- **The checklist is a side panel.** On a wide screen (900 px and up) the thread view has two columns: the messages (with the composer under them only) and a Checklist column about 260–340 px wide, with "Checklist · N of M", a donut and a thin progress bar, the **For you** and **For the agent** sections, and an add box at the bottom (pick who it is for, then type). **Hide ›** collapses it to a slim vertical tab that reopens it. Open or hidden is remembered per thread in `localStorage`; with no saved choice it is open when the thread has items and hidden when it has none. The item rules are unchanged (only the agent ticks, "I've done this", edit and delete your own, read-only threads show no controls).
- On a narrow screen the panel becomes a **Checklist 2/11** button in the thread header that opens a bottom sheet with the same content. The sheet is a modal dialog: it traps focus, closes with ×, Esc, the backdrop or a swipe down on its header, and returns focus to the button. The panel is a labelled region and the toggles carry `aria-expanded`.
- **L** shows or hides the checklist (the bottom sheet on a narrow screen); **C** and **Y** still add items and now also open it. L is listed in the `?` overlay.
- **A donut progress ring** replaces the text tally on each sidebar thread row (ticked items in the accent colour, claimed items lighter, the rest the track, with "2/11" beside it and the full label "2 of 11 done, 1 claimed" for screen readers). The same ring sits in the panel header, the tab and the narrow button. Hand-rolled SVG; the inbox serves one more file, `donut.js`.
- **The feedback widget can be dragged.** Drag the Feedback button, or the toolbar by its blank parts, with a mouse, pen or finger. A press that moves under 5 px is still a click. On release it clamps inside the viewport and snaps to the nearest edge, and the toolbar follows it (above in the lower half of the screen, below in the upper half). The position is remembered per origin in `localStorage` and re-clamped when the window resizes or rotates. With the button focused, Alt+arrow keys nudge it (Shift for bigger steps); **Reset position** in the toolbar (and the `?` text) puts it back. The `position` prop and `data-position` now only choose where it starts. It stays on the same top layer and out of screenshots.

### Changed
- Messages in the inbox use a roving tabindex: one message is the tab stop (the one last focused, else the newest) and the Up and Down arrow keys (also Home and End) move between messages. Before, every message was a tab stop. J and K still change thread.
- The inbox's profile box has a clear strip below it at phone width, so the launcher no longer covers its right part.

### Fixed
- `reply_to` may not name a merge divider: the API answers 400, as it does for an unknown id.

## 0.4.0

### Added
- **Quote replies.** A message may carry an optional `reply_to` (the id of an earlier message in the same thread). The server validates it (400 for an unknown id), stores it, returns it from the thread API and adds it to the user's `_events.jsonl` line. The inbox has a Reply action on every message (hover or focus, **R** on a focused message, swipe right on touch with a visible Reply button as the fallback), a quote bar above the composer, and a compact quoted snippet on the reply that scrolls to and highlights the original ("Original message unavailable" if it is gone). CLI: `reply <id> "text" --to <message-id>` (also `ask`); `read <id>` now also prints the thread with each quote's context. Merging keeps and remaps the links. Waiting and unread logic is unchanged.
- `position` prop on the widget (`"bottom-left"`, the default, or `"bottom-right"`) and `data-position` on the embed script.
- `hints` prop (`"off"` default, `"on"`) and `data-hints` on the embed script, for the step banner.
- `FEEDBACK_FOLD_FYI=1` folds the agent's FYI and Done messages in the inbox (off by default).

### Changed
- The step banner is no longer shown while Region, Element or Section is active, because it covered the page being captured. Pass `hints="on"` for the old behaviour; `?` still lists every shortcut. The markup editor keeps its hints.
- The inbox shows every message in full by default; FYI and Done messages used to fold to one line.
- The inbox page puts the launcher bottom-right and keeps a clear strip under the composer so the launcher does not cover Send.

## 0.3.0

### Added
- More ways for an inbox area to match a page: `suffix` (the path ends with it) and `prefix` (the raw path starts with it, plain text, so `/missions` also takes `/missionsx`). A rule matches when any matcher it lists does, and the first matching rule still wins.
- `fallback` (`{ "key", "label" }`): every path that matches no rule goes to that one group instead of the first-segment grouping. Without it, 0.2.0 behaviour is unchanged.
- `order`: the group keys in the order the sidebar and the metrics list them, `conversations` included. Without it, the default order is unchanged.
- `subHeading` (with `sub`): keep one group and show the sub-values as headings inside it, instead of one sub-group each. The group key stays `key`, so a pin on the group keeps working.
- `FEEDBACK_INBOX_WIDGET=0` keeps the capture widget off the inbox page.

### Changed
- `areaOf` may return `{ area, sub }` for a `subHeading` rule; the TypeScript declarations are updated.

## 0.2.0

### Added
- Configurable inbox areas. Set `FEEDBACK_AREAS` (a JSON file) or `FEEDBACK_AREAS_JSON` to name and group threads by path prefix, with `exact` matches, per-segment sub-groups (`sub`) and a renamable "Conversations" group. The config is checked at startup and the server refuses to run with a clear message if it is wrong. The effective list is served at `GET /__feedback/api/areas`, so the inbox, the pins and the metrics group the same way. Without a config the grouping is unchanged.
- Pins work for configured keys and sub-groups (`key:sub`).
- `react-feedback --help` (also `-h` and `help`) prints the usage and exits 0.

### Fixed
- Area keys that start with an underscore (a page like `/_admin`) can be pinned: the pin check and the key derivation now share one pattern.
- The shipped `.d.ts` files use `.js` extensions on relative imports, so the types resolve under `moduleResolution: node16` and `nodenext`.
- Importing the package on a server (SSR) no longer throws; the library entry now starts with `"use client"`.

### Changed
- Test data uses generic paths.

## 0.1.0

First release: the React capture widget, the Bun server, the inbox, the CLI and the metrics page.
