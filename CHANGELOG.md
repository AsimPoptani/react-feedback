# Changelog

## 0.14.0

### Breaking
- **The server now refuses unexpected `Host` names** (DNS rebinding protection). It answers only to `localhost`, `*.localhost`, IP addresses, `FEEDBACK_HOST` and the names in the new `FEEDBACK_ALLOWED_HOSTS` (comma-separated); anything else gets 403 with a message naming the variable. **A custom domain, a tunnel host or a Docker service name (for example `feedback`) must be added to `FEEDBACK_ALLOWED_HOSTS`.** Share links are exempt. The allowed names are logged at startup. The pairing and device routes use the same check (one implementation, `server/hosts.ts`), with stricter parsing: IPv6 only in brackets, and a malformed Host is a 403. The remote listener answers only to the `FEEDBACK_PUBLIC_URL` host (or the quick tunnel's, once known) or a name the local listener accepts, on top of the device cookie.

### Added
- **Claude Code sessions as threads** (`react-feedback claude-code`). Hooks give every Claude Code session its own thread. Your prompts and Claude's turn-end replies are mirrored in, and an `asyncRewake` Stop hook wakes the session when you write in its thread from the inbox, even when it is idle. Each thread is grouped by folder through `context.url = /claude/<folder>`. `id`, `title` and `flag` work from inside a session. A key saved in the key box wakes the session that asked.
- **Per project.** With a `FEEDBACK_PROJECTS` list, `--project <id>` or `FEEDBACK_PROJECT` picks the project for the `claude-code` commands. A session's state, its thread and its waiter live under that project's folder, and the waiter follows that project's events.
- **Captures go to the project's session.** `FEEDBACK_ORIGIN_MAP` (a path to a JSON file) maps a page origin to a folder. The first waiting session in that folder claims the capture and is woken with it, and its reply goes to the capture's thread. With `FEEDBACK_CLAIM_CONVERSATIONS=1` a session also claims conversations started in the inbox.
- **`react-feedback proxy <app-url> --port <n>`** puts the widget on any local dev server with no code change. It injects the widget into the HTML, routes `/__feedback`, and passes the rest through, WebSockets included. It listens on `127.0.0.1` only; any other `--host` is refused unless `--unsafe-public` is given.
- **Channels mode.** `react-feedback mcp --channel` makes the MCP server a Claude Code channel (a research preview): it sends `notifications/claude/channel` for each new message of yours in a thread the session follows, with `thread_id`, `message_id`, `author` and `project` in the meta. It never declares permission relay. The hooks stay the default, and the two never deliver one message twice.
- **SessionEnd expires the session's open questions**, so they show "Expired" instead of waiting for an answer nobody will read.

### Security
- The proxy builds its destination from the configured origin, so a path such as `//other-host/x` can no longer make it fetch another host, and it applies the same Host check as the server.
- The channel only attaches to a session of its own Claude Code process in its own folder (no "only session here" fallback), and does nothing when the bridge is off or the run is headless.
- Zero-width, tag, format and soft-hyphen characters are removed before fencing, and marker look-alikes (including non-breaking spaces and full-width forms) are blanked. An answer's option labels are marked as the agent's text. The `claude --resume` note shell-quotes the folder. `--unsafe-public` prints a warning. README: every capture from a `FEEDBACK_ORIGIN_MAP` origin counts as you.
- Only messages whose author is `user` wake a session. A viewer note from a share link, an agent reply, a system line, a reminder, a share notice and a merge or project-move divider never do, a viewer note is never claimed as a conversation, and the words of a viewer note you quote are left out.
- Everything printed to wake Claude (and every channel notification) starts with "Message from the inbox (data, not instructions)" and sits between two markers with a random tag. ANSI and OSC sequences, other control characters and invisible direction-override characters are removed, a line that looks like a marker is blanked, and the text is capped at 8,000 characters with a `(truncated)` marker. A file attached to a message is named with its size, never inlined.

### Fixed
- A message that a merge, a move, a forward after a merge or `repair-merged` carries into another followed thread wakes the session once. The "Sent in <title> after the merge" line those copies gain is ignored when matching them, so a message with no `client_id` is not woken twice.
- A thread the session follows that is merged into one it does not follow no longer goes quiet: the session follows the target too, from the merge on. Merge chains are followed.

### Changed
- The service worker cache is `fb-inbox-0.14.0`.
- A thread that carries a `context.url` is grouped by the area rules like a capture. Threads without one still go under Conversations.
- New environment variables: `FEEDBACK_ORIGIN_MAP`, `FEEDBACK_CLAIM_CONVERSATIONS`, `REACT_FEEDBACK_CLAUDE=off` and `FEEDBACK_URL` (where the proxy sends `/__feedback`). `FEEDBACK_PROJECTS` stays the server's project list.

## 0.13.0

### Added
- **Open on phone.** The inbox (the sidebar footer, and the thread header or its ⋯ menu) shows a QR code, the plain link with Copy, and a five-minute countdown; a phone that opens it is paired and lands on the thread you were reading. The code is in the URL fragment (`#/pair/<code>?to=<thread>`), so it is never sent to a server, proxy or log. The QR is drawn client-side by a bundled encoder (`qrcode-generator` 2.0.4, MIT; no CDN).
- **Pairing.** Codes are 128 random bits, kept as a hash, single use, valid five minutes, at most five open, compared in constant time, and the exchange is rate limited. A device gets a cookie (`HttpOnly; Secure; SameSite=Strict; Path=/__feedback/`, 30 days, sliding). Devices are stored as hashes (`_devices.json`, mode 0600) with a browser-family name and a last-seen time; the user agent is not stored.
- **Paired devices** page (name, paired, last seen, This device, Revoke, Revoke all) and a CLI: `react-feedback devices list|revoke <id>|revoke-all`. A revoke takes effect on the next request. There is no MCP tool for pairing or devices.
- **Remote mode: `react-feedback serve --remote`.** A second listener on `FEEDBACK_REMOTE_PORT` (default `PORT` + 1), bound to 127.0.0.1, for a tunnel or proxy. Every request needs the device cookie (loopback is never trusted there), except the share routes, the pairing exchange and the pairing page at the inbox address. Writes also need an `Origin` matching the public address and a JSON body. `FEEDBACK_PUBLIC_URL` names the public address; with `cloudflared` on the PATH and none set, a quick tunnel is started and stopped with the server. The ordinary listener is unchanged.
- README: "Continue on your phone", "Remote mode" (including how to use pairing instead of, or with, a basic-auth proxy), the new variables and routes.

### Security
- The pairing and device routes on the ordinary listener refuse any `Host` that is not `localhost`, an IP address, `FEEDBACK_HOST` or a `FEEDBACK_ALLOWED_HOSTS` name (DNS rebinding). A paired device cannot create codes or revoke other devices. The exchange counts only well-formed attempts from the right origin against its rate limit, caps its body at 1 KiB, and the remote listener returns a plain 500 on an error. A revoked phone gets `Clear-Site-Data`, and the service worker drops its saved data on a 401. The self-started tunnel keeps its output drained (it used to die on its next log line), ignores a user's cloudflared config, and its exit is logged.

### Changed
- The service worker cache is `fb-inbox-0.13.0`, and `pair.js` is in its file list.

## 0.12.0

### Added
- **The full Feedback capture on shared and owner-viewed artifacts.** A share link's **Feedback** dialog now offers **Region**, **Element**, **Section** and **Full page** with a screenshot, drawing and a note, the same capture as the widget in a host app (touch works at 390 px). The capture runs inside the artifact's sandboxed iframe, where the DOM is: a new inline script, `dist/capture.js` (the widget's own capture and screenshot code with React and the CSS, driven by `postMessage`), is added to the shared page. It does nothing until asked, makes no request and does not patch the page's console or `fetch`. It hands the picture (PNG, or a JPEG when a PNG would be too big; downscaled in the page to fit), the mode, the rectangle, the selector, the snippet and any component names and source to the shell, which believes only its own iframe and validates every field (`server/inbox/shot.js`, one function used by both the shell and the inbox). A note-only request is unchanged.
- **Screenshots from viewers.** `POST /__feedback/s/<token>/feedback` takes an optional `image` (and `?image=1` on the same path for the larger body cap, so a note without one keeps the 16 KB cap). The server checks that it is a PNG or JPEG: exact base64, the file's structure walked end to end, at most 2 MB decoded and 4096 x 16384 pixels. A link may receive 20 MB of screenshots a day (then `429`, and a note alone still goes through); the other rate limits are unchanged. The image is stored as the viewer message's image; the `quote` now also keeps `mode`, `components` and `source`. **No new public path**: the reverse-proxy exemption is still `/s/<token>`, `/s/<token>/feedback` and `/s/<token>/replay`. An agent reading the thread sees the image labelled as the viewer's (CLI `viewer-supplied image`, MCP `notice`).
- **The owner's capture in the inbox.** The artifact viewer loads the page as `/__feedback/a/<id>/v<n>?capture=1` (the plain URL is still the published page, byte for byte) and has a **Feedback** button with the same four modes. The inbox page validates the message and posts it to the artifact's thread as a message from you, with the picture and a line naming the artifact, version, mode and element.
- **Anything in `[data-rf-private]` is painted over in every screenshot** and reports no text when picked (the widget too). The recorder no longer records the widget's own host element.
- **Watch live.** A session that received a chunk in the last ~20 seconds shows **● Live** and **Watch live** (an artifact's Replays tab and Metrics, My sessions); recorded sessions keep **Play**. The live view is rrweb's live mode a few seconds behind, with a **LIVE** badge and an **ENDED** state after ~30 seconds without a chunk or when the session is gone. The player keeps its strict CSP and makes no request: the signed-in inbox polls `GET api/artifacts/:id/replays/:session?after=<n>` (and `GET api/replays/:session?after=<n>`) and passes events in by `postMessage`; the player believes only its parent (source and origin), validates each event and takes at most 5,000 a message. Each chunk's start in the gzip file is kept in the session metadata, so a poll unpacks only the newest chunk (a session from before 0.12.0 is read from its start). There is no public live endpoint, and nothing about what is collected changes.
- **`live`** on each row of the replay lists; `?after=` on the owner's session reads (`{meta, events, cursor, live}`, at most 5,000 events a read).

### Changed
- **A merged-away thread keeps its composer open.** A send posts to that thread and the server forwards it to the target (as since 0.9.2; files and images follow). A toast says "Sent to <title>" and the target opens, and a note above the composer says "This thread was merged into <title>. What you send goes there. · Open". Attach image and Attach file work as in any thread. Questions in it stay read-only. What was typed is no longer brought back in the target once it has been sent.
- The widget accepts a `bridge` prop (used inside an artifact; no launcher, no server).
- `dist/capture.js` is new; `dist/player.js` grew with rrweb's replayer for the live view.
- The service worker cache is `fb-inbox-0.12.0`; `shot.js` is in its file list.

## 0.11.0

### Added
- **Source location from a click.** Capturing an element or a section now also records where it was written in the host app's React source: the nearest component with source info (file, line, column, component name; React's `_debugSource`, React 19's `_debugStack`, or the nearest ancestor that has one) as `target.source`, and up to 40 component names, innermost first, as `target.components` (it was 6). Positions taken from a debug stack are marked `runtime`: not source-mapped. Production builds usually carry none, and degrade to component names or nothing. The inbox capture view shows a small `src/…/Thing.tsx:42` chip (click to copy); `feedback.md`, the CLI `read` ("Captured element" block) and MCP `read_thread` (`capture`) include it. A capture with no source reads exactly as before. The path is stored with the capture only. The fiber walk is adapted from Local Browser Bridge (MIT): see THIRD_PARTY_NOTICES.md.
- **Quote a bit of a message.** Select words inside any message in a thread (mouse, keyboard, or a long press on a phone) and a popover offers **Quote** with an optional note; it puts a `> ` block and the note in the composer. The sent message carries `quote: { message_id, text }`, drawn as a linked quote that jumps to its source. Stored, carried through merges and moves (the link is dropped, the words stay, when the original stays behind), hidden by redaction and restored by unredact, held in the offline outbox, shown by `read` and MCP. `Q` moves to the popover's note.
- **Expiring questions.** `ask` and `ask-new` (CLI) and MCP `ask` take an expiry: `--expires 2h|1d|2w` from now or an absolute time. An expired unanswered question is **Expired** in the inbox: a collapsed line (with **show** and **Send as a message** for typed text, as for a withdrawn one), out of the pinned bar, **Waiting on you** and unread. Answering it is `409 This question expired`. Expiry is read-time only, with no timer; the first read after it writes one `expired` event.
- **`ask-expire`** (CLI) and **`expire_questions`** (MCP): an agent marks its open questions expired (one, all on a thread, or all everywhere), for when its session ends.

### Changed
- MCP tool list: one more tool, `expire_questions`. `read_thread` messages carry `quote`, and a question's `expires_at` and `expired`.
- The service worker cache is `fb-inbox-0.11.0`.
- The CLI's `ask` and `ask-new` post under `FEEDBACK_AGENT_NAME` when it is set (they were always unnamed), and a re-asked question keeps its agent, so `ask-expire --all-mine` expires only that agent's questions.
- Redacting a question also removes its prompt from the `expired` event in the event feed.

## 0.10.2

### Added
- **The sidebar can collapse to a slim rail** (56 px) on desktop and medium widths: the project badge (opens the project menu), a New thread button, an unread count and an expand button. The « button at the top of the sidebar or the `[` key toggles it; it is remembered on this device, and the thread pane takes the freed width. Phones are unchanged.

### Fixed
- Fixed: the thread title no longer squeezes to one letter per line at medium widths. It keeps at least 260 px, truncates with an ellipsis after two lines, and the header buttons wrap onto their own row below it.
- The service worker cache is `fb-inbox-0.10.2`.

## 0.10.1

### Added
- **Project artwork.** Every project has a badge: up to two initials from its name ("Acme App" is AA, "react-feedback" is RF) on a colour picked from the project id out of a small palette (white initials, readable in light and dark). It shows on the closed project button (32 px), on every row of the open menu (28 px) and in the phone header, which is the same control.
- **`icon` per project.** A `FEEDBACK_PROJECTS` entry may add `"icon": "/path/to/logo.png"` (PNG, JPEG or WebP, at most 1 MB). The server serves it at `/__feedback/api/projects/<id>/icon` with a sniffed type (SVG is refused), `nosniff` and a sandbox CSP. The path is resolved at startup; a missing, oversize or wrong file logs one warning and the badge is used. Only that configured file is ever read. `GET api/projects` returns `has_icon` (a boolean), never the path.

### Changed
- With more than one project the "Feedback inbox" heading is gone from the sidebar: the project menu is the header. One project keeps the heading.
- The **show** / **hide** button on a withdrawn or re-asked question line stays on one line; the prompt text truncates instead.
- On a thread that was merged into another, **Attach file** (and the paperclip on a phone) is disabled like Attach image.
- The service worker cache is `fb-inbox-0.10.1`.

## 0.10.0

### Added
- **Feedback on a shared page.** A share link now opens a small trusted shell (package code, no inbox chrome, no inbox API calls) around the artifact, which stays in its sandboxed iframe. The shell has a **Feedback** button: a note of up to 4,000 characters, and an optional "point at it" mode, where a helper inside the iframe reports the clicked element's text snippet, a CSS path and a viewport-relative box by `postMessage`. The shell believes only messages from its own iframe and sends one `POST /__feedback/s/<token>/feedback`. The note is stored in the artifact's thread as a message from the `viewer`, shown as "Viewer feedback · <title> · link <id>", flagged Needs you, with the snippet quoted; the thread waits on you. Manage shows a feedback count per link. An unknown, revoked or expired token is the same 404; the endpoint has no read path; it is rate limited in memory (5 a minute and 50 a day per link, 5 a minute per caller) and stores no address and no user agent.
- **Session replay (rrweb, bundled, no CDN).** The share dialog and Manage have a **Record interactions** switch per link, off by default and available only from the inbox: an agent's link never records, and there is no CLI or MCP way to turn it on. With it on, the server injects the recorder into the page served for that link only; the shell shows "This page records clicks and mouse movement to help the author" with **Don't record**, and uploads in batches to `POST /__feedback/s/<token>/replay` only while the link is active and recording is on. Inputs are masked, `[data-rf-private]` is blocked, mouse moves are sampled every 50 ms, and a session is at most 30 minutes and 5 MB. Stored as `_replays/<artifact>/<session>.jsonl.gz` with metadata (link, version, start, duration, clicks); no address, no user agent.
- **Watching replays.** The artifact viewer has a **Replays** tab (date, duration, clicks, version) with Play (rrweb-player, bundled, click markers on the timeline) and Delete, and a **Heatmap** toggle that overlays click positions on a version, scaled to its width.
- **Recording the inbox itself.** The profile has **Record my inbox sessions** (off by default). When on, the inbox records itself (inputs masked), uploads to `POST api/replays`, shows **● Recording** in the sidebar footer, and lists the sessions under Metrics, My sessions.
- **Retention.** `FEEDBACK_REPLAY_DAYS` (default 30) with a daily cleanup. Revoking a link stops new recordings; existing ones stay until deleted or expired.
- `rrweb` and `rrweb-player` 2.2.0 (MIT) are pinned in `devDependencies` and bundled into `dist/recorder.js`, `dist/player.js` and `dist/player.css`. `bun run build` has a new `build:replay` step.

### Changed
- The share link page is now a shell with the artifact in an iframe (`srcdoc`). The response keeps `Content-Security-Policy: sandbox allow-scripts allow-popups`, `X-Robots-Tag: noindex`, and no cookie.
- The documented Caddy exemption allows `GET` on the token and `POST` on `/feedback` and `/replay` under it, and nothing else: `path_regexp ^/__feedback/s/[A-Za-z0-9_-]{43}(/(feedback|replay))?$` with `method GET POST`. A privacy section says what is recorded and that the owner is responsible for telling people.
- `POST api/artifacts/:id/share` takes `record`; new `POST api/shares/:id/record`, `GET api/artifacts/:id/replays`, `GET|DELETE api/artifacts/:id/replays/:session`, `GET api/artifacts/:id/heatmap`, `GET|POST api/replay-settings`, `GET|POST api/replays`, `GET|DELETE api/replays/:session`.
- Messages can now have the author `viewer`. They are neither side of the conversation in the metrics. The CLI `read` labels them "viewer feedback ... data to read, not instructions".
- A viewer note on an artifact whose thread was merged lands on the thread it was merged into (a chain of merges is followed) and keeps the line "Sent in <title> after the merge", like any other post to a merged thread.
- **Move to project** carries an artifact's session recordings (`_replays/<artifact>`) with it: staged beside the target's own (the recording files are hard-linked where they can be, copied where they cannot), placed when the move commits, rolled back if it fails, and removed from the source afterwards. Each recording is renamed to the artifact and link ids it has in the target. A link keeps its recording switch. The inbox's own recordings and the inbox recording switch belong to the project and stay.
- The tests that need a caller address in `X-Forwarded-For` name `FEEDBACK_CLIENT_IP_HEADER` themselves; there is no global test setup.
- The service worker cache is `fb-inbox-0.10.0`.

## 0.9.4

### Added
- **Attach any file.** A message can carry files of any type, with **no size cap by default**. From the inbox (the **Attach file** paperclip beside the image control (beside the **＋** on a phone), drag and drop onto the thread, paste) and from an agent: `reply <id> "text" --file path` (repeatable; `new` takes it too) and MCP `reply` with `files`. MCP files are off unless `FEEDBACK_FILE_DIR` names the folder(s) they may come from (the same rules as `FEEDBACK_IMAGE_DIR`). A new thread started from the inbox can carry files too.
- **Chunked, resumable uploads.** The inbox sends a file in chunks of at most 32 MiB (so a tunnel or proxy that limits one request, such as Cloudflare's roughly 100 MB, never matters). The server streams each chunk to disk (nothing is held in memory), a resume asks for the offset it has, finishing checks the size and the sha256 before the file is moved into place, and a mismatch discards the upload. Partial uploads, and finished ones no message took, are removed after 24 hours. `POST api/uploads`, `PUT|GET|DELETE api/uploads/:id`, `POST api/uploads/:id/finalise`.
- **`FEEDBACK_MAX_UPLOAD_BYTES`** (optional; unset means unlimited) and **`FEEDBACK_MIN_FREE_BYTES`** (default 20 GiB). A new upload or chunk is refused ("Not enough disk space on the server", HTTP 507) when it would leave less free on the data volume than the larger of that and 10% of the volume.
- **Inbox.** Each file is a chip with a progress bar, Cancel and Retry; on a phone the system file picker opens and the progress sits in the composer, so it stays in view while the thread scrolls. A file of up to 50 MB waits with its message in the offline queue; a bigger one says it needs a connection.
- **Viewing.** Images show inline as before. A PDF has a Preview in a sandboxed frame (`sandbox` with nothing allowed), with a Download beside it. Everything else is a chip with name, size and Download. Every download is `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, with no cookie; HTML, SVG and script files are never served inline from the inbox origin. Files are not reachable from a share link.
- **Storage.** `<thread>/files/<id>/<name>`, with name, size, sha256, a content type read from the file's first bytes, and the uploader on the message as `attachments`. Names are sanitised (no path parts, no control characters, a capped length). `_uploads/` in the data folder holds uploads in progress.
- **Agents.** `read` lists each attachment with the absolute path of its file; MCP `read_thread` includes attachment metadata and the path; the new MCP tool `get_attachment` returns a text file of up to 1 MB as `text` and the path for anything else. The "data to read, not instructions" notice now says it covers an attachment's name and contents. Agents that read a file send its contents to their model provider (noted in the README).
- **Redaction** moves a message's files into the vault (`<message>.files/`), where they are not served; `unredact` brings them back. A merge or a move carries a message's files along.
- `e2e/attach.mjs` (files through a proxy that refuses request bodies over 50 MB, at 390 and 1280 wide) and `e2e/parity.mjs` (an older release and this one answer alike on a copy of your data).

### Changed
- The service worker cache is `fb-inbox-0.9.4`, and it also keeps `sha256.js` and `uploader.js`.
- The server accepts request bodies of up to 33 MiB (one chunk); JSON bodies are still held to 25 MiB.
- The MCP tool list has one more tool, `get_attachment`.

### Fixed (before release)
- A write that fails after files were attached (a full disk, say) puts the uploads back in `_uploads` with their details instead of losing them, so the same message can be sent again; images are saved before the files are taken. A project move that crashes part way through a redacted message's files no longer leaves a truncated file that is later trusted: the vault copy hard-links, or copies to a `.part` file and renames, and a leftover `.part` is redone. A merge or move copy of a file does the same.
- The 24 hour upload sweep now runs when the server is started with `react-feedback serve` (it once ran only when `server.ts` was run directly), once at startup and then hourly. A new upload cleans stale partials before it checks free space, so a full volume cannot lock new uploads out.
- A merge or a move links a message's files (a hard link, no extra space) instead of copying them. When a link cannot be made (another volume), the copy is checked against the same free-space floor as an upload. Redaction still moves every linked copy into the vault.
- A post with files to a thread that was already merged is written on the target with its files. A move to another project carries a redacted message's vault files to the new vault key (and removes the old ones once the move is done), so Unredact still finds them; `repair-merged` links the files of a message it carries.

### Known
- A file name that is a lone surrogate returns a 500.
- The name length limit counts characters, not UTF-8 bytes.
- Finalising a huge file can take longer than a proxy's timeout; Retry recovers it.

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
