# Changelog

## 0.9.3

### Added
- **Move a thread to another project.** `move-project <thread> <project> [--dry-run]`, MCP `move_project`, and **Move to project…** in the thread's ⋯ menu (a desktop button too). Only when `FEEDBACK_PROJECTS` has more than one project. The folder moves with its images, checklist, reminders and other files, and so do the artifacts and share links that belong to it — a link keeps working and keeps its view count — and the vault entries for redacted messages. A thread merged into it moves with it. The id stays when the target does not already use it; when it does, a new id is assigned and every reference is rewritten. Both projects get a `moved` event, and the thread gains a system line, "Moved from" followed by the source project's name. A failure leaves the thread where it was. Running it again finishes the move or changes nothing.

### Fixed
- **Typing an answer is not lost when the question is withdrawn or re-asked.** The open thread picks the change up on the next poll. The question collapses to one muted line — "Withdrawn ·" the prompt and, when there is one, the reason — or "Re-asked below" linking to the new copy — and leaves the pinned bar. Options, Other and Submit are hidden; **show** expands it read-only. Whatever was selected or typed stays, with **Send as a message** (a normal reply quoting the question) and, when it was re-asked, **Use on the new copy**. Submitting after it has gone does the same, instead of only showing "That question was withdrawn" under the composer.

### Changed
- The service worker cache is `fb-inbox-0.9.3`.

## 0.9.2

### Fixed
- **A merge keeps each answer on its question.** Copying a thread renumbers its messages and question ids. The same map, built before anything is written, now rewrites every id the copy carries: `answer.question_id`, `reply_to` (including a side question and its answers), the checklist items a message added or ticked, and the question's own id. An answered question stays answered in the target, so it does not come back in the "Waiting for your answer" bar, in `list --waiting`, or in the open count.

### Added
- **`react-feedback repair-merged [--dry-run]`.** For a thread merged before this fix, re-points answers that still name the source question id. It also copies an answer that was posted on the merged thread after the merge, with the question id rewritten and a line saying where it was sent, and records that copy so a second run does not add it again. A withdrawal whose reason starts with "Answered:" or "Settled:" is removed when it travelled with the copy, or when it was added after the merge and an answer in the target names that question. A later withdrawal with no answer is left, and so is any other withdrawal. It can do this only when the old-to-new map is still recoverable (the map stored with the merge, or the source lined up after the merge divider). Otherwise it says so and changes nothing.
- **A post to a thread that was already merged is written on the target.** The message keeps a line, "Sent in <title> after the merge", and an answer's question id is rewritten from the merge map. The API returns that message with `forwarded_to` set to the target. Asking a new question on the merged thread is refused. The inbox shows "Merged into <target> · Open" and disables the composer and the question cards; if a send races the merge, `forwarded_to` opens the target and shows a short toast.

- **Typed text survives a merge.** If a thread is merged while you are typing, the composer text and any Other answer are kept (the composer becomes read-only so you can still copy it) and are restored as a draft when you open the target; an Other answer is prefixed with the question as a quote. An answer refused with "already answered" on a thread that has since been merged shows "This thread was merged into <title> · Open" and carries the typed text the same way.
- **`repair-merged` follows a chain of merges.** An answer left on A after A was merged into B, when B has since been merged into C, is carried onto C with the question ids composed along the chain. If a link has no usable map, the answer is left with "target was merged into X". Stranded answers are now found by position after the merge farewell, not by time.

### Changed
- The service worker cache is `fb-inbox-0.9.2`.

### Known
- Two redaction tests can fail if run at 14:11 (the thread id contains 4111); fixed in a later release.

## 0.9.1

### Fixed
- The pinned "Waiting for your answer" bar no longer wipes an answer being typed in its Other box. The inbox polls every 10 seconds, and each poll rebuilt the bar. It now rebuilds only when the open questions change, and typed text carries over a rebuild for the same thread.

## 0.9.0

### Added
- **Artifacts.** An agent can publish an HTML or Markdown page on a thread (`artifact publish`, MCP `publish_artifact`). Pages live in `_artifacts/<id>/v<n>/` and stay when a new version is published. Markdown is rendered with the inbox's safe renderer. A page is at most 5 MB. The thread shows a card (title, version, Open, and a Shared pill when a link exists). The sidebar links to an Artifacts page. The viewer is `…/inbox/#/artifact/<id>`. The page itself is served from `/__feedback/a/<id>/v<n>` with `Content-Security-Policy: sandbox allow-scripts allow-popups` (no `allow-same-origin`), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and the viewer embeds it in a matching sandboxed iframe, so a page cannot read the inbox's storage, cookies or API.
- **Secret share links.** From the viewer, or by an agent (`artifact share`, MCP `share_artifact`). The link is `/__feedback/s/<token>` (32 random bytes, 43 base64url characters, only the sha256 stored). An agent's link is pinned to the version that was current. From the inbox, a link can follow later versions; publishing onto that link scans the new text and refuses it when the scan hits, and the thread records "New version vN is now live on a shared link". The page is served with the same sandbox, `X-Robots-Tag: noindex`, and no inbox chrome. Revoked, expired and unknown tokens are the same 404. Views and the last view are counted; no address or user agent is stored. The pill reads "Shared · 2 links · viewed 5×". Manage lists each link (who created it, expiry, version, views, last viewed) with Revoke. An agent's link expires in 1, 7 (the default) or 30 days; a link with no expiry is created from the inbox only. An agent share is refused when the page looks like it contains a secret; the person can still share it after a warning. An agent can revoke only a link it created. `suggest_share` asks with a Share? button and does not create a link. When an agent creates a link, the thread gets a line the person can revoke from.
- **Projects.** `FEEDBACK_PROJECTS` is a JSON list of `{id, name, dir}`. Unset, the server is the one project `FEEDBACK_DIR` has always been, and `?project=` is ignored. Set, each project has its own threads, artifacts, shares, events and agents. The API takes `?project=<id>` (omitted means the first). The sidebar shows the project name and, when there are two or more, a menu with unread counts. The last choice is remembered on the device. CLI and MCP take `--project` or `FEEDBACK_PROJECT`.
- **Pinned questions.** Unanswered questions sit in a "Waiting for your answer" bar above the composer (the newest, and "2 more" when several are open). One question with up to four options shows those options in the bar. `ask-cancel` / `cancel_question` withdraws one (struck through, no longer waiting). `ask-bump` / `bump_question` asks it again at the bottom and marks the old copy "Re-asked below".
- **Answer chips.** An answer shows "↩ q109 · …" and jumps to the question. `read` and the event's `first_line` name the question and a short prompt, for example `q109 (Build secret share links…): Yes, build it`. Older answers get the chip from the question id already stored.

### Changed
- The service worker cache is `fb-inbox-0.9.0`.
- `POST api/threads/:id/read` requires `Content-Type: application/json`.
- The documented Caddy matcher for a share link is anchored to the 43-character token.

## 0.8.2

### Added
- **The version, and a nudge when a newer one is deployed.** The sidebar footer shows "react-feedback vX.Y.Z" next to Tracker and Metrics. On a phone the same line is the footer of the thread's ⋯ menu. `GET api/config` includes `version`, read from the package. The page that is open keeps the version it loaded. When that differs from the server (the server was redeployed), a small banner at the top says "A new version (vX.Y.Z) is ready. Reload to update", with Reload and a dismiss ×. Reload checks the service worker, tells a waiting one to take over, and loads the new shell. Dismiss stays quiet for that version only; the next one asks again. Checked when the page loads and on every poll.
- `react-feedback --version` prints the version.

### Changed
- `zod` 4.6.6 (was 4.1.12) for this package and for the MCP SDK, which accepts `^4.0`. Earlier 4.x releases can exhaust memory while validating an oversized collection (GHSA-mrhx-c7xc-m3w5).

## 0.8.1

### Added
- **Last seen, for both sides.** The inbox's thread header shows a quiet line such as "Agent · active 2 min ago" (one per agent name): relative under an hour, the time after that in the viewer's local zone, hidden when there is no data, shown on read-only threads. Each viewer sees the other side only: the inbox shows the agents; an agent sees the user's "last seen" and the other agents, not itself. The agent's last active is its latest CLI command (under `FEEDBACK_AGENT_NAME`, so it matches the MCP server of that name) or MCP tool call; the user's last seen is the latest inbox page load, poll or message sent, written at most once a minute. Stored as one small file per writer in `<FEEDBACK_DIR>/_presence/` (timestamps and the agent name only, no address or browser), and only in a data folder that already exists. `GET api/presence`; `react-feedback list` and `read` print the lines on stderr (stdout is unchanged); the MCP `list_threads` and `read_thread` return `presence`. Existing data is untouched.

### Changed
- **Fired reminders are no longer drawn in the thread** (any layout). Their history is the **Fired** list, with times, in the Reminders sheet. The event in `_events.jsonl` and `reminders_fired` in the thread detail are unchanged.

## 0.8.0

### Added
- **Thread reminders.** Per-thread nudges for the agent, stored in `reminders.json`: `every` (an interval; fires only if the thread had activity since the last fire), `after_agent_replies` (N agent replies in a row with no checklist change) and `idle` (waiting on the agent longer than X). A **built-in reminder** is on for every thread with open agent items (after 3 agent replies with no tick, or 6 h after the last fire with user activity: "This thread has N open agent items: is the checklist up to date?…", without the title, so a redacted note cannot survive in it); off per thread, or everywhere with `FEEDBACK_DEFAULT_REMINDER=off`. The server checks every 60 s and the CLI and MCP server check after each agent reply; a fire is stored under the thread's lock (restart-safe) and appended to `_events.jsonl` as `author: "system"`, `kind: "reminder"`. The inbox shows a muted "⏰ Reminder to the agent" line; it is never unread and never notifies. CLI: `remind <id> add|list|remove|off-default|on-default`; `reply` prints "N open items here; tick any you shipped with --check cN" on stderr when the thread has open agent items and the reply ticks or adds nothing. Inbox: a **Reminders** sheet (⋯ menu on a phone, a header button on a wide screen), also on read-only threads. HTTP: `api/threads/:id/reminders`.
- **MCP server.** `react-feedback mcp` serves the inbox over stdio with the official `@modelcontextprotocol/sdk` (1.32.2): `list_threads`, `read_thread`, `reply`, `ask`, `new_thread`, `todo_add`, `todo_check`, `tracker`, `merge`, `move`, `ack`, `remind_add`, `remind_list`, `remind_remove`, `events_since`. No `redact`, `unredact` or `ask_secret`. Tools call the store directly (same limits and per-thread locks as the CLI), return people's text in data fields with a notice, and take images only from `FEEDBACK_IMAGE_DIR`. HTTP transport is not implemented.
- **Agent names.** `FEEDBACK_AGENT_NAME` names an MCP agent; its messages carry `agent_name`, it has its own read marker (`agent-read-<name>-<hash>.json`), and the inbox shows the name with a colour made from it. Existing messages are unchanged.

- **Loop and leak guards.** A reminder never fires twice within 15 minutes; `after_agent_replies` needs 2 or more; `every` and the built-in 6 h rule count the user's activity, not the agent's replies. Redacting a message blanks its lines in the thread's `reminders.json` and in the reminder events (same byte length). Each reminder records who set it (`created_by`, `agent_name`), and the fired event carries `set_by` (`agent`, `user` or `default`) and `agent_name`; MCP `events_since` returns the event text as a `text` data field.
- **Images over MCP are off unless `FEEDBACK_IMAGE_DIR` is set** (never the working folder; `/` and the home folder refused; no-follow open, judged on the open file; every refusal answers alike). Agent names that look like the user or the system are refused and invisible characters removed.

### Changed
- `agent_read_at` in a thread summary is the newest read time of any agent (the same value when only one agent has read).
- The metrics ignore `system` events.
- New dependencies: `@modelcontextprotocol/sdk` 1.32.2 and `zod` 4.1.12 (used by the MCP server only).

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
