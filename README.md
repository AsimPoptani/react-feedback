# react-feedback

In-app feedback for React apps. A floating widget lets a person capture a **region**, an **element**, a **section** or the **full page**, optionally draw on it, write a note and send it. A small Bun server stores each note as plain files, serves an **inbox** for two-way threads, and ships a **CLI** so a person or a coding agent can read and reply. No external service or account is involved.

> Screenshot placeholder: add your own images of the widget and the inbox here (use demo data, never real threads).
>
> `![The capture widget](docs/widget.png)` `![The inbox](docs/inbox.png)`

- `src/widget/`: the React capture widget (ESM plus types, and a drop-in script).
- `server/`: the Bun file server, store, metrics, CLI and the static inbox site.
- `dist/`: the built widget. **It is committed**, so installing from git works without a build step.

## Install

From git, pinned to a commit or tag (do not track a branch):

```sh
bun add github:AsimPoptani/react-feedback#<commit-or-tag>
# or: npm install github:AsimPoptani/react-feedback#<commit-or-tag>
```

`react` and `react-dom` (18 or newer) are peer dependencies. `modern-screenshot` is a normal dependency. The server and CLI need [Bun](https://bun.sh).

> **Install from git, not the npm registry.** An unrelated package called `react-feedback` exists on npm. `npm install react-feedback` or `bunx react-feedback` without a local install would fetch that one instead.

## Use in a React app

```tsx
import { FeedbackWidget, FeedbackErrorBoundary } from "react-feedback";
import "react-feedback/feedback.css";

export function Root() {
  return (
    <>
      <App />
      <FeedbackErrorBoundary>
        <FeedbackWidget endpoint="/__feedback" />
      </FeedbackErrorBoundary>
    </>
  );
}
```

`endpoint` is the base URL of the feedback server and defaults to `/__feedback`.

Other props:

- `position`: `"bottom-left"` (default) or `"bottom-right"`, the corner that holds the launcher, its panels and the "Queued" toast. It is only where the launcher starts: people can drag the button (or the toolbar) anywhere, it snaps to the nearest edge, the spot is remembered per origin in `localStorage`, Alt+arrow keys nudge it, and **Reset position** in the toolbar puts it back.
- `hints`: `"off"` (default) or `"on"`. While Region, Element or Section is active the widget shows no step banner, so nothing sits over the page you are capturing; press `?` for the shortcuts. `"on"` brings the banner back. To ship it only in development, render it behind your own flag and lazy-load it:

```tsx
const FeedbackWidget = import.meta.env.VITE_FEEDBACK === "1"
  ? lazy(() => import("react-feedback").then((m) => ({ default: m.FeedbackWidget })))
  : null;
```

**Server-side rendering:** importing the package on the server is safe (nothing touches `window` at load, and the entry carries `"use client"`), but the widget only works in the browser, so mount it on the client. In Next.js, use `dynamic(() => import("react-feedback").then((m) => m.FeedbackWidget), { ssr: false })` in a client component.

**TypeScript:** the shipped types resolve under `bundler`, `node16` and `nodenext` module resolution.

Exports: `FeedbackWidget`, `FeedbackErrorBoundary`, and the types `FeedbackWidgetProps`, `Capture`, `CaptureMode`, `ElementTarget`, `FeedbackItem`, `Rect`, `Shot`, `Target`.

### Theming

The widget is styled by CSS variables with defaults. Set any of them on `:root` (or an ancestor of the widget) to match your app:

| Variable | Meaning | Default (light) |
| --- | --- | --- |
| `--rf-bg` | panel background | `#f3f7f5` |
| `--rf-ink` | text colour | `#192f38` |
| `--rf-border` | borders | `#a2b5ad` |
| `--rf-accent` | focus ring and Save button | `#00796f` |
| `--rf-accent-ink` | text on the accent colour | `#fff` |
| `--rf-font` | font family | `system-ui, sans-serif` |

Without overrides the widget follows `prefers-color-scheme` and uses a dark default palette. If you set a variable it applies in both schemes.

## Drop-in script (any page, no React needed)

```html
<script src="https://your-host/__feedback/embed.js" data-endpoint="/__feedback"></script>
```

`dist/embed.js` is a standalone bundle (React and the CSS are inside it). The server also serves it at `/__feedback/embed.js`, and the inbox loads it, so you can capture feedback about the inbox itself. `data-endpoint` defaults to `/__feedback`. `data-position="bottom-right"` moves the launcher to the right corner (default `bottom-left`; the starting spot, since the button can be dragged), and `data-hints="on"` shows the step banner during capture modes (default off).

## Run the server

```sh
./node_modules/.bin/react-feedback serve   # after installing from git (see Install)
# or, from a checkout: bun bin/react-feedback.ts serve
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `FEEDBACK_DIR` | `./feedback-data` (relative to the working directory) | where everything is stored |
| `FEEDBACK_HOST` | `127.0.0.1` | bind address (the shell's `HOST` is ignored) |
| `PORT` | `8099` | port |
| `FEEDBACK_AGENT_NAME` | `Agent` | display name of the agent in the inbox |
| `FEEDBACK_AREAS` | none | path to a JSON file that configures the inbox areas (see [Inbox areas](#inbox-areas)) |
| `FEEDBACK_AREAS_JSON` | none | the same configuration as inline JSON (set only one of the two) |
| `FEEDBACK_FOLD_FYI` | off | set to `1`, `on`, `true` or `yes` to fold the agent's FYI and Done messages to one line with a Show button; by default every message is shown in full |
| `FEEDBACK_INBOX_WIDGET` | on | set to `0`, `off`, `false` or `no` to keep the capture widget off the inbox page itself |
| `FEEDBACK_SECRET_TARGET` | none | a path on the same site, with `{name}` in it (for example `/api/keys/{name}`), that the inbox's key box sends a pasted key to (see [Secure key box](#secure-key-box)). Must be relative; an absolute or protocol-relative URL stops the server at startup. Unset: no key box |
| `FEEDBACK_VAULT_DIR` | none | where redacted messages go (see [Redacting sensitive messages](#redacting-sensitive-messages)). Must be **outside** `FEEDBACK_DIR`. Unset: redaction is off |

Open `http://127.0.0.1:8099/__feedback/inbox/`.

Docker:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production
ENV FEEDBACK_HOST=0.0.0.0 FEEDBACK_DIR=/data PORT=8099
VOLUME /data
EXPOSE 8099
CMD ["bun", "bin/react-feedback.ts", "serve"]
```

### Reverse proxy

The widget talks to the same origin as your app, so forward `/__feedback` unchanged to the server. With nginx:

```nginx
location /__feedback/ {
  proxy_pass http://127.0.0.1:8099;
  proxy_set_header Host $host;
  client_max_body_size 30m;   # screenshots are sent as data URLs, up to 25 MiB
}
```

With Vite in development:

```ts
server: { proxy: { "/__feedback": { target: "http://127.0.0.1:8099", changeOrigin: true } } }
```

## Where the data is stored

Plain files under `FEEDBACK_DIR`, one folder per thread:

```text
feedback-data/
  YYYYMMDD-HHMMSS-abcd/
    item.json       note, mode, target, context and image file names
    status.json     {"status":"open"} or "done"
    feedback.md     the note first, brief context and relative image links
    image.png       original crop or full page
    annotated.png   only when the user drew on the capture
    context.png     the viewport with the target outlined (not for full page)
    thread.jsonl    the conversation, one JSON message per line, append-only
    msg-<n>.<ext>   images attached to messages (png, jpg, webp)
    read.json       when the user last opened the thread
    agent-read.json when the agent last read it
    checklist.json  the thread's checklist, written atomically
    merged.json     only on a thread that was merged away
    (redacted messages leave no text or images here: see the vault)
  _events.jsonl     one line per user message or new thread: watch it to know when to look
  _profile/         names, avatars and pins.json
```

Console diagnostics in a capture are bounded (30 entries of 300 characters; 20 failed fetches with query strings removed). No request headers, request bodies or response bodies are captured. Add the folder to your `.gitignore`.

## Capture flow and keyboard shortcuts

Pick a mode, select a target, write one note, press Save. Saving sends at once from an outbox that retries, so a flaky connection does not lose a note. Esc steps back one level. Shortcuts use physical key codes and never fire inside the host app's inputs.

| Where | Keys | Action |
| --- | --- | --- |
| Global | Alt+Shift+F | Toggle toolbar |
| Global | Alt+Shift+R / E / S / P | Region / Element / Section / Full page |
| Global | Alt+Shift+L | My feedback |
| Toolbar | R / E / S / P or 1 / 2 / 3 / 4 | Choose mode |
| Toolbar | ? | Shortcut cheat sheet |
| Selecting | Enter | Capture and write note |
| Element / Section | Up / Down | Parent / child |
| Region | Arrows, Shift+arrows | Move 1 px / 10 px |
| Region | Alt+arrows | Resize bottom-right |
| Note | Cmd/Ctrl+Enter | Save and send |
| Note | Alt+D | Draw on it |
| Markup | P / B / A / T, 1 / 2 / 3, Cmd/Ctrl+Z, Enter | Pen / box / arrow / text, colour, undo, use markup |
| Open widget | Esc | Back one level |

## The inbox

`/__feedback/inbox/` lists threads grouped by area. By default an area is the first segment of the page path they were taken on (`/billing/plans` goes under "Billing", `/` under "Home", threads started without a capture under "Conversations"); see [Inbox areas](#inbox-areas) to name and group them yourself. It shows status pills and unread dots, a thread view with the original capture and message bubbles, a composer (Cmd/Ctrl+Enter sends, paste or attach images), a checklist side panel for the person and the agent (a donut on each thread row shows progress; **L** shows or hides it, and on a phone it is a bottom sheet), pins, merging, a read-only "updates" thread type, and a **Metrics** page (velocity, response times, workload, by-area table). Press `?` for the inbox shortcuts. Text is escaped; only bold, italics, inline code, `-` lists and http links are rendered.

### Inbox areas

Out of the box the inbox groups by the first path segment. To use your own groups and labels, give the server a list of rules in a JSON file (`FEEDBACK_AREAS=/path/to/areas.json`) or inline (`FEEDBACK_AREAS_JSON='[...]'`):

```json
[
  { "key": "home", "label": "Start page", "match": "/", "exact": true },
  { "key": "billing", "label": "Billing", "match": "/billing" },
  { "key": "projects", "label": "Projects", "match": "/projects/", "sub": 1 }
]
```

| Field | Meaning |
| --- | --- |
| `key` | the group's id: 1 to 40 characters of `a-z`, `0-9`, `_` or `-`, unique; used for pins. `conversations` is reserved |
| `label` | the heading shown in the inbox and the metrics (up to 80 characters) |
| `match` | a path prefix starting with `/`. `/billing` matches `/billing` and everything under it, but not `/billingx`. Case-insensitive; the query string and fragment are ignored |
| `exact` | optional; match only that exact path (`"/"` with `exact` is the home page alone, without it `"/"` would match every page) |
| `sub` | optional whole number; make one sub-group per value of the nth path segment after the prefix, so `/projects/p1/tasks` becomes "Projects / p1". A path with no such segment goes in the plain area |
| `subHeading` | optional, with `sub`; keep **one** group and put the sub-values under headings inside it instead, for example `"project {sub}"`. The group key (and its pin) stays `key`, and the metrics count it as one |
| `suffix` | optional; the path ends with this text, for example `/checkout`. Case-insensitive; the query string and fragment are ignored |
| `prefix` | optional; the raw path starts with this text, for example `/missions` also takes `/missionsx`. Plain text, case-sensitive; unlike `match` it does not stop at a path segment, and it gives no sub-groups |

A rule needs at least one of `match`, `suffix` or `prefix`, and matches when **any** of the matchers it lists does (so `{ "key": "setup", "label": "Set-up", "match": "/setup", "suffix": "/wizard" }` takes `/setup/...` and any page ending in `/wizard`). `exact` and `sub` go with `match`; a sub-group only comes from a prefix match.

The first rule that matches wins, so put specific rules before general ones. A path that matches no rule falls back to the first-segment grouping. Configured groups are listed first, in the order you wrote them (sub-groups alphabetically), then the fallback groups, then "Conversations".

To change that, write the config as an object:

```json
{
  "areas": [
    { "key": "home", "label": "Start page", "match": "/", "exact": true },
    { "key": "setup", "label": "Set-up", "suffix": "/wizard" },
    { "key": "projects", "label": "Projects", "match": "/projects", "sub": 1, "subHeading": "project {sub}" },
    { "key": "reports", "label": "Reports", "prefix": "/report" }
  ],
  "fallback": { "key": "other", "label": "Other pages" },
  "conversations": "Chats",
  "order": ["home", "projects", "reports", "setup", "other", "conversations"]
}
```

- `fallback` sends every path that matches no rule to one group, instead of the first-segment grouping. Its key must not be used by a rule.
- `conversations` renames the group for threads started without a capture (they are never matched against the rules).
- `order` lists group keys in the order the sidebar and the metrics show them; keys you leave out follow in the default order (rules in the order written, the fallback, Home, other pages alphabetically, then Conversations). Put `"conversations"` in the list to place it. Rules are matched in the order of `areas`, whatever `order` says.

The server checks the config when it starts and refuses to run with a clear message if it is wrong (unknown field, duplicate key, bad `match`, unreadable file). It serves the effective list at `GET /__feedback/api/areas`, which the inbox reads, so the inbox, the pins and the metrics (the `metrics` command included, which reads the same variables) all group the same way. A group key is the rule's `key`, or `key:sub` for a sub-group; both can be pinned.

## CLI

The CLI writes straight into `FEEDBACK_DIR` through the same store the server uses, with no HTTP:

```sh
react-feedback serve                                            # start the server
react-feedback --help                                           # print the usage
react-feedback list [--waiting]                                 # threads waiting for the agent
react-feedback reply <id> "text" [--image a.png --image b.jpg] [--to <message-id>]   # --to quotes one of that thread's messages
react-feedback reply <id> "text" --aside --to <aside-id>       # answer a side question (/btw)
react-feedback reply <id> "text" --todo "item" [--todo ...] [--for agent|user] [--check c3 ...]   # checklist changes ride on the reply
react-feedback move <from-id> <message-id> [<message-id> ...] --to <into-id>   # move messages to another thread
react-feedback tracker [--mine | --claimed | --open]            # every checklist item across the threads
react-feedback new "title" "text" [--image path ...]            # an agent-started thread
react-feedback status <id> open|done
react-feedback read <id>                                        # stamp the agent read marker, then print the thread with each quote's context
react-feedback ack <id>                                         # the user's latest message is handled; no reply
react-feedback ask <id> "prompt" --option "Label|optional description" ... [--multi] [--no-other]
react-feedback ask-new "title" "prompt" --option ... [--multi] [--no-other]
react-feedback reply|new|ask ... [--needs-you | --done | --fyi] # flag the message (default fyi; ask defaults to needs-you)
react-feedback todo <id> add agent|user "text"                  # checklist items; also list, done, uncheck, unclaim, edit, rm
react-feedback todos [--mine | --claimed]
react-feedback merge <from-id> <into-id>
react-feedback new "title" "text" --read-only                   # an updates thread the user cannot reply to
react-feedback readonly <id> on|off
react-feedback profile agent --avatar path                      # square PNG, JPEG or WebP, up to 2 MB
react-feedback metrics [--window 24h|7d|all]
react-feedback ask-secret <id> --name <key-name> --label "Label" [--help-url <https url>]   # a secure key box in the thread
react-feedback redact <id> <message-id> [--reason "why"]        # move a sensitive message into the vault (needs FEEDBACK_VAULT_DIR)
react-feedback unredact <id> <message-id>                       # put it back from the vault (CLI only)
```

## Quote replies

Any message can quote an earlier one in the same thread, WhatsApp style. A message may carry an optional `reply_to: "<message id>"`; old messages have none and nothing else changes (a quote is metadata only: it does not affect who is waiting, unread marks or ticks). The server returns 400 if `reply_to` is not a message of that thread. A merge keeps the links, renumbered with the messages.

- **Inbox, desktop:** hover or focus a message and press **Reply**, or focus it and press **R**. A quote bar (author, first line, ×) appears above the composer; Esc in the composer cancels it.
- **Inbox, phone:** swipe a message to the right; a visible Reply button is always shown on touch screens.
- A reply shows a compact quoted snippet (author and first line, or "Image"); tapping it scrolls to the original and highlights it. If the original is gone it reads "Original message unavailable".
- **CLI:** `reply <id> "text" --to <message-id>` (also on `ask`).

On the inbox page the launcher sits bottom-right (`data-position="bottom-right"`), with a clear strip under the composer so it never covers Send.

## Side questions (`/btw`)

Type `/btw your question` in the inbox composer (or press **B**, or use the **Side question** button) to ask something without disturbing the main thread. The message carries `aside: true`; the agent's answers are messages with `aside: true` and `reply_to` set to the question. Old messages have neither field.

- **Inbox:** each side question and its answers show as a compact, collapsible "Side question" bubble set apart from the main flow. It is collapsed once answered and open, with a "Waiting for agent" pill, until then.
- **Waiting:** the main flow's last-message logic ignores asides. A thread with an unanswered aside has `waiting: "agent"` (unless the main flow waits on you) and `waiting_aside: true` in its summary (the field is absent otherwise). `ack` clears it too.
- **CLI:** `reply <id> "text" --aside --to <aside-id>`; `list --waiting` marks threads with a side question waiting; `read` prints each aside indented under "Side question".
- A side answer takes no flag, and neither side can put a question or a quote in an aside. A merge keeps asides and their links.

## Checklist items on replies

`reply <id> "text" --todo "item" [--todo "…"] [--for agent|user]` adds checklist items as part of the message (default: the agent's own list); `--check c3 [--check c4]` ticks items. The message stores `added_items` and `ticked_items`, and the inbox shows "Added to checklist" / "Ticked" lists inside the bubble, each item jumping to its row in the panel. Over HTTP a user message may carry `todo` (a list of texts) and `for`; `check` is refused with 403 because only the agent ticks. The whole message is checked first: nothing is written if an id or a text is wrong. Read-only threads still refuse the user's items.

## Moving messages

`react-feedback move <from> <msg-id> [<msg-id> ...] --to <into>` moves messages (the user's too), with their images, original times and authors, into another thread, behind a "Moved from: …" divider. Each moved message leaves a "Moved to <title>" stub at its old spot (same id, so quotes of it still resolve). Quotes between moved messages are remapped; a quote of a message that stayed is dropped. Items a message added move with it. A question moves with its answer, and a side question with its answers. Dividers, merged threads, a read-only target (for user messages) and the same thread are refused. Both threads are locked; an interrupted move is finished by running the same command again. It logs a `move` event.

## Tracker

`#/tracker` in the inbox lists every checklist item across the threads that were not merged away, in For you, For the agent and Done recently (ticked in the last seven days, collapsible), with a donut for overall progress, filters by thread and by state, and a search box. Each item links to its row in its thread. The item rules are unchanged. `GET api/tracker?thread=&state=open|claimed|done&q=` returns the same data; the CLI prints it with `tracker`.

## Markdown

Message bodies render a safe GitHub-flavoured subset: headings (`#` to `####`), tables (with alignment, scrolling inside the bubble), nested and ordered lists, read-only task lists, blockquotes, rules, inline and fenced code, links (https, mailto and in-app only, opened in a new tab with `rel="noopener noreferrer"`), bold, italic, strikethrough and line breaks. No HTML is ever parsed: everything is built with `createElement` and `textContent`. Quote snippets, previews and the tracker show plain text; the CLI prints the raw text. The renderer is `server/inbox/markdown.js` (no dependency).

## Secure key box

`react-feedback ask-secret <id> --name openrouter --label "OpenRouter API key" --help-url https://openrouter.ai/keys` posts a message of kind `secret_request` (`{ name, label, help_url }`) that asks the user for a key. **No value is ever stored by the feedback server.**

- The inbox draws a password box in the message (autocomplete off, no browser storage, no `name`), with Save, a "Where to get this" link and the name of the slot it fills. It is not a `<form>`, so a browser has no password to offer to save.
- On Save, the **browser sends the value straight to your app**: `PUT <FEEDBACK_SECRET_TARGET with {name} filled in>` with `{"value": "…"}` and `Content-Type: application/json`, same origin only (`redirect: "error"`, so a redirect cannot carry it elsewhere). The target must be a relative path; the server refuses to start with an absolute URL, and the inbox refuses to send to one. The inbox learns the target from `GET /__feedback/api/config` (`{ secret_target, redact }`).
- On a 2xx the box is cleared and the inbox records only `saved` and the target's short `hint` (at most 8 characters, such as `…abcd`, read from the target's JSON reply) with `POST api/threads/:id/messages/:mid/secret`. The route refuses any other field, so a value cannot ride along. The message then reads "Saved ✓ · ends …abcd", stops asking for the user's attention, and logs a `secret` event (`<name> saved`, never a value) so the agent can carry on. On a non-2xx the box stays and shows the target's error text (`detail`, `error` or `message`). If the reply carries `check: "rejected"` the message says the provider rejected the key; `check` is recorded with the hint (`works` or `rejected`).
- With `FEEDBACK_SECRET_TARGET` unset the message says "Secure entry isn't set up on this server" and shows no box. Offline it says "Connect to save this key": a key is never queued or stored for later.
- The value never reaches the thread, `_events.jsonl`, any log, `localStorage` or the offline cache. It exists only in the input until your app has it.

Your app's route must accept the same-origin `PUT`, check its own authentication and Origin as it does for any write, and answer JSON such as `{ "hint": "…abcd" }`; it must never echo the value in an error.

## Redacting sensitive messages

If something private lands in a thread, redact it. The agent runs `redact <id> <message-id> [--reason "…"]`; the user opens the **⋯** on one of their own messages and chooses **Redact…** (the inbox only offers it when `FEEDBACK_VAULT_DIR` is set, and only on the user's own messages).

- The message's text and pictures move to the **vault**: `FEEDBACK_VAULT_DIR/<thread>/<message>.json`, a directory at `0700` and files at `0600`, written atomically. It must be outside `FEEDBACK_DIR` and is **never served over HTTP**.
- In the thread the message becomes `{ text: "", images: [], redacted: { at, by, reason?, key } }`, shown as "🔒 Redacted (sensitive)" with the time and who did it. Quotes and snippets of it show "🔒 Redacted". The image files are deleted from the thread folder; the text is removed from `thread.jsonl`, search, the API and the CLI; its first line is blanked in `_events.jsonl` in place (the line keeps its byte length, so anything following the file by offset stays in step). A first message that a thread repeats in `item.json` and `feedback.md` is blanked there too, and the copy a merge made in the other thread is redacted with it.
- A question's prompt and option labels are hidden the same way.
- **Restore** is CLI only: `unredact <id> <message-id>` reads the vault back (pictures return under new numbers) and removes the vault file. The inbox has no restore.
- Redaction works on read-only threads. Back up the vault separately; it is the only copy.

## Offline sending (inbox)

The inbox registers a small service worker (`sw.js`, scoped to the inbox path) that saves the page, its scripts, the thread list and each thread you opened. With no signal the inbox still opens and shows what you last saw, with an "Offline · showing what you last saw" banner. (Service workers need https or localhost.)

- Sending while offline, or when a send fails on the network, stores the message (text, pictures, `/btw` side questions and quote-replies) in an **IndexedDB outbox** and shows it in the thread with a clock and "Waiting to send". You can delete it before it sends.
- When the connection returns (the `online` event, or a retry with backoff) queued messages go out **in order**, one at a time; a failed one holds the ones behind it. Each carries a `client_id`, and the server stores a message with a given `client_id` once however often it arrives (a repeat answers 200 with the stored message). A message the server refuses (a thread that became read-only, say) is marked "Couldn't send" with Try again and Delete.
- The message keeps the time you wrote it as `written_at`, shown in the thread. `created_at` stays the time it arrived, so read ticks and acknowledgements stay right; a bad `written_at` (in the future, over 30 days old) is ignored.
- Read-only threads refuse to queue anything. Secret key entry is never queued. Nothing but ordinary messages is stored, and no pictures or secrets are cached by the service worker; a browser without IndexedDB keeps the queue in memory and says so. The saved copy of a thread is replaced the next time you are online and open it, so a message redacted since then disappears from it too.

## Phone layout

At 760 px and narrower the thread view is one slim header (← title, the checklist donut, **⋯** with Pin, Merge into…, Mark done or Reopen, and the read-only note), and a one-line composer: **＋** (Attach image, Side question), an auto-growing text box (about five lines at most) and a send arrow. Enter adds a new line; Send is the button. Keyboard hints are hidden on touch screens (`(hover: none) and (pointer: coarse)`), the Feedback launcher hides while the composer has focus, and the page follows `visualViewport` so an open keyboard leaves the message list the remaining height, scrolled to the newest message. Wide screens keep the old layout.

## HTTP API

All under `/__feedback/`. `GET healthz`; `GET|POST api/items` (the widget's capture endpoint); `GET api/items/:id/:file`; `GET|POST api/threads`, `GET api/threads/:id`, `POST api/threads/:id/messages|status|read|answer|merge` (a message body may carry `reply_to`, the id of an earlier message in the same thread; an unknown id is a 400); `GET|POST|PATCH|DELETE api/threads/:id/checklist`; `GET|POST api/profile`; `GET|POST api/pins`; `GET api/areas`; `GET api/metrics?window=24h|7d|all`; `GET api/tracker`. A message body may also carry `aside: true`, `todo` and `for`, and `client_id` and `written_at` (an offline queue's id and writing time). Also: `GET api/config`; `POST api/threads/:id/messages/:mid/redact` (the user's own messages, when a vault is set); `POST api/threads/:id/messages/:mid/secret` (`{ status: "saved", hint? }` only).

A capture is `POST api/items` with a JSON body of at most 25 MiB: `{ note, mode: "region"|"element"|"section"|"page", target?, image, annotated?, context_image?, context }`. Notes are 1 to 10 000 characters; `image` must be a PNG data URL.

## Security notes

This is meant for **local or development use**. The server has **no authentication**, anyone who can reach it can read every capture (screenshots can contain whatever is on the page) and write threads. Do not expose it to the internet as it is. Bind it to `127.0.0.1`, or put authentication in front of it (a reverse proxy with basic auth or SSO, or a private network or tunnel with access control). Do not run it in production builds of your app: gate the widget behind a flag. Uploaded images are checked by signature and size, file names are fixed or generated, and all stored text is escaped in the inbox. The key box and the vault do not change that: they keep a key out of the thread, and a redacted message out of the served data, but they do not authenticate anyone. Anyone who can reach the server can still ask it to redact the user's messages.

## Development

```sh
bun install
bun run typecheck && bun run lint
bun run test        # vitest (widget and the inbox page in happy-dom) and bun test (server, store, CLI)
bun run test:e2e    # optional browser smoke test (needs Playwright and a built dist/)
bun e2e/rf6.mjs     # optional browser test: phone layout, key box, redaction, offline sending (same needs)
bun run build       # rebuilds dist/: index.js, index.d.ts, feedback.css, embed.js
```

Commit `dist/` together with any change to `src/widget/`, because git installs use it as is.

## Licence

MIT, see [LICENSE](LICENSE).
