# Changelog

## 0.7.1

### Fixed
- Inbox on a phone: scrolling up past the top of a thread no longer pulls the whole page and reloads it. The page itself never scrolls (`overflow: hidden`, `overscroll-behavior: none` on `html` and `body`), and each scroller inside it (message list, thread list, checklist, metrics) uses `overscroll-behavior-y: contain`. Only the inbox page changes; the widget on a host page is untouched.
- Inbox on a phone: a read-only thread shows no composer at all (only the "Updates only" note); it used to show a typeable one that refused on send.
- Inbox on a phone: a swipe that starts inside a wide table or code block pans it and no longer starts a reply. Tables and code blocks keep their sideways scroll to themselves (`overscroll-behavior-x: contain`, `touch-action: pan-x pan-y`).
- Inbox on a touch screen: the Feedback launcher no longer floats over the messages. **Feedback on this page** is in the header's ⋯ menu instead. Desktop, and the widget on host pages, keep the floating launcher.

## 0.7.0

### Added
- **Phone layout.** At 760 px and narrower: one slim header (← title, the checklist donut, **⋯** holding Pin, Merge into…, Mark done or Reopen and the read-only note) and a one-line composer (**＋** for Attach image and Side question, an auto-growing text box of up to about five lines, a send arrow). No keyboard hints on touch screens (the widget's launcher too). The Feedback launcher hides while the composer has focus. The page follows `visualViewport` and `100dvh`, so an open keyboard leaves the message list the remaining height, scrolled to the newest message, and the header shrinks. Wide screens are unchanged.
- **Secure key box in chat.** `ask-secret <id> --name N --label "L" [--help-url https://…]` posts a `secret_request` message. The inbox draws a password box; Save sends the value from the browser straight to `FEEDBACK_SECRET_TARGET` (a relative path with `{name}`, `PUT {"value": …}`, same origin, no redirects). The value never reaches the feedback server, the thread, `_events.jsonl`, logs or storage. On 2xx the box clears and only `saved` and the target's hint (at most 8 characters) are recorded through `POST api/threads/:id/messages/:mid/secret`, which refuses any other field; the message shows "Saved ✓ · ends …abcd". A non-2xx shows the target's error and keeps the box. If the app's reply says `check: "rejected"` (it tried the key against the provider) the message reads "Saved, but the provider rejected it" instead of "Saved ✓". The box names the slot it fills ("OpenRouter API key → openrouter_api_key") and is not a `<form>`, so browsers have nothing to offer to save. With no target set it says "Secure entry isn't set up on this server". New `GET api/config` tells the inbox the target and whether redaction is on.
- **Redact sensitive messages.** `redact <id> <message-id> [--reason "…"]` (agent) and **Redact…** under **⋯** on the user's own messages. The text and pictures move to the vault, `FEEDBACK_VAULT_DIR` (outside `FEEDBACK_DIR`, directory `0700`, files `0600`, atomic, never served). The message shows "🔒 Redacted (sensitive)" with the time and who did it; quotes show "🔒 Redacted"; search, the API, the CLI and metrics no longer see the text; its first line is blanked in `_events.jsonl` in place; every copy a merge or a move made is redacted too, through chains of merges and in both directions (a failure to reach one is reported, and running `redact` again retries it); a capture's title is blanked in the dividers and stubs that repeat it; an answer's Other text is blanked in `_events.jsonl`; a capture's `feedback.md` is rebuilt, and `unredact` restores it. `POST …/redact` and `…/secret` need a JSON body like every other write. `unredact <id> <message-id>` restores it (CLI only).
- **Offline sending in the inbox.** A service worker (`sw.js`, scoped to the inbox) keeps the page and the last thread data, so the inbox opens offline with an "Offline · showing what you last saw" banner. Messages sent offline (or when a send fails on the network) wait in an IndexedDB outbox, shown with a clock and "Waiting to send", and go out in order when the connection returns (also when only a server restart cleared the problem, with no `online` event), each once (messages carry a `client_id`; the server stores one `client_id` once). They keep the time they were written as `written_at`. They can be deleted before sending; read-only threads refuse to queue; a key is never queued ("Connect to save this key").

### Changed
- The inbox page is laid out as a column (offline banner, then the app) instead of a fixed-height grid.


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
