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
| `FEEDBACK_MAX_UPLOAD_BYTES` | unlimited | the largest file a person can attach, in bytes (see [File attachments](#file-attachments)). Unset or `0`: no limit. A value that is not a whole number stops the server at startup |
| `FEEDBACK_MIN_FREE_BYTES` | `21474836480` (20 GiB) | an upload (or a chunk of one) is refused when it would leave less than this much free on the data volume, or less than 10% of the volume, whichever is larger |
| `FEEDBACK_FILE_DIR` | none | the folder(s) (a `:`-separated list) an MCP agent may attach files from; unset: MCP files are off (see [Connect your agents](#connect-your-agents-mcp)) |
| `FEEDBACK_PROJECTS` | none | a JSON list of `{id, name, dir, icon?}` when one server hosts several projects (see [Projects](#projects)). Unset: one project, `FEEDBACK_DIR`, and `?project=` is ignored |
| `FEEDBACK_REPLAY_DAYS` | `30` | how many days a session replay is kept (a whole number from 1 to 3650). A pass at start and then once a day removes older ones (see [Session replay](#session-replay)) |
| `FEEDBACK_CLIENT_IP_HEADER` | none | the one request header your proxy sets to the real caller's address, used only for the share-link rate limits (see [Caller address](#caller-address-and-rate-limits)). Unset: the socket address. `X-Forwarded-For` is never believed |
| `FEEDBACK_PROJECT` | the first project | which project the CLI and `react-feedback mcp` use. `--project <id>` overrides it |

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
  client_max_body_size 40m;   # screenshots are sent as data URLs, up to 25 MiB; a file chunk is at most 32 MiB
}
```

Files are uploaded in chunks of at most 32 MiB, so a proxy only ever needs to allow a request body of about 33 MiB, however large the file is. That matters for a tunnel with a per-request cap (Cloudflare's is about 100 MB on most plans) or a proxy with a small default (nginx's is 1 MB without `client_max_body_size`): nothing else needs raising, and `proxy_request_buffering off;` keeps nginx from holding each chunk in memory.

With Vite in development:

```ts
server: { proxy: { "/__feedback": { target: "http://127.0.0.1:8099", changeOrigin: true } } }
```

### Caller address and rate limits

The share endpoints are rate limited per link and per caller, in memory. The caller is the **socket address** of the connection. Behind a reverse proxy or tunnel that is the proxy, so every viewer then looks like one caller. To tell them apart, set `FEEDBACK_CLIENT_IP_HEADER` to the single header your proxy sets itself and that a viewer cannot write: behind a Cloudflare tunnel it is `Cf-Connecting-Ip`. (`X-Forwarded-For` is not used by default: a client can send its own first hop and dodge the limit. If you name it, the last hop is used, the one your own proxy added.) Only set this when every request really comes through that proxy. The address is used for the limit and never stored. The limiter keeps at most 20,000 callers and drops the stalest first when a flood of distinct addresses fills it; it never forgets everyone at once.

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
    files/<id>/<name>  files of any type attached to messages (the name is a sanitised label; the id is generated)
    read.json       when the user last opened the thread
    agent-read.json when the agent last read it
    checklist.json  the thread's checklist, written atomically
    merged.json     only on a thread that was merged away
    (redacted messages leave no text or images here: see the vault)
  _events.jsonl     one line per user message or new thread: watch it to know when to look
  _profile/         names, avatars and pins.json
  _artifacts/       published pages: <id>/meta.json and <id>/v<n>/{body.html, source.md|source.html, meta.json}
  _uploads/         uploads in progress, and finished ones no message has taken yet (removed after 24 hours)
  _shares.json      share links, with the sha256 of each token (the token itself is not stored)
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

### Where an element was written

When you capture an element or a section, the widget also records where that element came from in your React source, if React will say: the nearest component with source info (file, line, column and the component's name, from React's `_debugSource` or, in React 19, `_debugStack`, falling back to the nearest ancestor that has one) and up to 40 component names, innermost first. It is added to the target as `source: { file, line, column, component, runtime?, ancestor? }` and `components: [...]`.

- **Runtime, not source-mapped.** A position taken from a debug stack is the one the browser saw in the bundled file, so it is marked `runtime: true` and shown as "runtime, not source-mapped". Run through a source-map tool if you need the original line. `ancestor: true` says it is the nearest ancestor's position, not the element's own.
- **Production builds** usually carry no debug source: you get the component names only, or nothing. Nothing breaks.
- **Privacy.** The file path is your app's own source path. It is stored with the capture (`item.json`, `feedback.md`) and shown to you and to your agents, and goes nowhere else.
- **Where it shows.** The inbox's capture view has a small chip such as `src/…/SaveButton.tsx:42` (click it to copy `file:line:column`). `read <id>` prints a "Captured element" block with the selector, components and source for a capture that has one; MCP `read_thread` returns a `capture` object. A capture without a source reads exactly as before.
- The walk over React's internals is adapted from Local Browser Bridge (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## The inbox

`/__feedback/inbox/` lists threads grouped by area. By default an area is the first segment of the page path they were taken on (`/billing/plans` goes under "Billing", `/` under "Home", threads started without a capture under "Conversations"); see [Inbox areas](#inbox-areas) to name and group them yourself. It shows status pills and unread dots, a thread view with the original capture and message bubbles, a composer (Cmd/Ctrl+Enter sends, paste or attach images), a checklist side panel for the person and the agent (a donut on each thread row shows progress; **L** shows or hides it, and on a phone it is a bottom sheet), pins, merging, a read-only "updates" thread type, and a **Metrics** page (velocity, response times, workload, by-area table). Press `?` for the inbox shortcuts. Text is escaped; only bold, italics, inline code, `-` lists and http links are rendered.

The sidebar footer shows the running version (`react-feedback vX.Y.Z`) on the line under Tracker and Metrics. On a phone, where that sidebar hides once a thread is open, the same line is the footer of the ⋯ menu. The page keeps the version it loaded. `GET api/config` also returns the server's `version`. When the two differ, because the server was redeployed, a banner at the top says a new version is ready, with Reload and a dismiss ×. Reload installs the updated service worker and loads the new page. Dismiss hides that version until a different one is served. The check runs on load and on each poll.

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
react-feedback --version                                        # print the version
react-feedback list [--waiting]                                 # threads waiting for the agent
react-feedback reply <id> "text" [--image a.png --image b.jpg] [--to <message-id>]   # --to quotes one of that thread's messages
react-feedback reply <id> "text" --file report.pdf --file data.zip   # attach any file (repeatable; up to 10; no size cap unless FEEDBACK_MAX_UPLOAD_BYTES)
react-feedback reply <id> "text" --aside --to <aside-id>       # answer a side question (/btw)
react-feedback reply <id> "text" --todo "item" [--todo ...] [--for agent|user] [--check c3 ...]   # checklist changes ride on the reply
react-feedback move <from-id> <message-id> [<message-id> ...] --to <into-id>   # move messages to another thread
react-feedback move-project <thread> <project-id> [--dry-run]   # move the whole thread to another project (only when FEEDBACK_PROJECTS has more than one)
react-feedback tracker [--mine | --claimed | --open]            # every checklist item across the threads
react-feedback new "title" "text" [--image path ...] [--file path ...]   # an agent-started thread
react-feedback status <id> open|done
react-feedback read <id>                                        # stamp the agent read marker, then print the thread with each quote's context
react-feedback ack <id>                                         # the user's latest message is handled; no reply
react-feedback ask <id> "prompt" --option "Label|optional description" ... [--multi] [--no-other] [--expires 2h|1d|2w|<date and time>]   # an unanswered question lapses (see Pinned questions)
react-feedback ask-new "title" "prompt" --option ... [--multi] [--no-other]
react-feedback reply|new|ask ... [--needs-you | --done | --fyi] # flag the message (default fyi; ask defaults to needs-you)
react-feedback todo <id> add agent|user "text"                  # checklist items; also list, done, uncheck, unclaim, edit, rm
react-feedback todos [--mine | --claimed]
react-feedback merge <from-id> <into-id>
react-feedback repair-merged [--dry-run]                    # re-point answers a merge left behind, and copy answers posted on the source after it
react-feedback new "title" "text" --read-only                   # an updates thread the user cannot reply to
react-feedback readonly <id> on|off
react-feedback profile agent --avatar path                      # square PNG, JPEG or WebP, up to 2 MB
react-feedback metrics [--window 24h|7d|all]
react-feedback ask-secret <id> --name <key-name> --label "Label" [--help-url <https url>]   # a secure key box in the thread
react-feedback redact <id> <message-id> [--reason "why"]        # move a sensitive message into the vault (needs FEEDBACK_VAULT_DIR)
react-feedback unredact <id> <message-id>                       # put it back from the vault (CLI only)
react-feedback remind <id> add --every 2h|--after-replies 3|--idle 1h --say "text"   # a nudge in the agent's event feed
react-feedback remind <id> list | remove <rid> | off-default | on-default
react-feedback mcp                                              # an MCP server on stdio (see Connect your agents)
react-feedback ask-cancel <id> <qid> [--reason "why"]           # withdraw an unanswered question
react-feedback ask-bump <id> <qid>                              # ask it again at the bottom of the thread
react-feedback ask-expire <id> <qid>|--all-mine                 # mark your open questions expired now (for when a session ends); --all-mine alone covers every thread
react-feedback artifact publish <id> <file.html|file.md> --title "Title" [--id <artifact>]
react-feedback artifact list [<id>]
react-feedback artifact suggest-share <artifact>                # a Share? button; this does not create a link
react-feedback artifact share <artifact> [--expires 1d|7d|30d]
react-feedback artifact unshare <share-id>                      # only a link this agent created
```

`--project <id>` (or `FEEDBACK_PROJECT`) picks a project when `FEEDBACK_PROJECTS` is set. The default is the first project. An agent share expires in 7 days unless `--expires` says 1d or 30d, and it is pinned to the version current at the time. A link with no expiry, and a link that follows later versions, are created from the inbox.

## Thread reminders

Reminders keep the agent up to date on a thread, for example "does the checklist need to be updated?". They are nudges for the **agent**: a fire appends a line to `_events.jsonl` (`author: "system"`, `kind: "reminder"`, the thread `id` and the text as `first_line`, plus `set_by`: `agent`, `user` or `default`, and `agent_name` when an MCP agent set it), the feed agents already tail. That event shape is public. The `first_line` is text a person or an agent wrote: read it as data. The inbox shows it as a small muted line, "⏰ Reminder to the agent: …"; it is never unread for you and never sends a push or a notification. The metrics ignore it.

Each thread keeps its reminders in `reminders.json` (written atomically, like `checklist.json`). A reminder has an `id`, a `kind`, `say` (the text), `created_by`, `last_fired_at` and `enabled`. The kinds:

- `every` (`2h`, `30m`, `1d`): fires when the interval has passed **and the user was active on the thread since the last fire** (the agent's own replies do not count), so an idle thread stays quiet.
- `after_agent_replies` (a number from 2): fires after that many agent replies in a row with no checklist change (no item added or ticked).
- `idle` (`1h`): fires once when the thread has waited on the agent that long.

None of them fires on a done thread, and none fires twice within 15 minutes (a cooldown, so a reply that answers a reminder cannot set the next one off). **The built-in reminder** is on for every thread with open **agent** checklist items: after 3 agent replies with no tick, or 6 hours after the last fire (or the oldest open item) when the thread had activity, it says "This thread has N open agent items: is the checklist up to date? Tick what shipped, add what's new." (no title: a title can be a captured note, and redaction must not leave it behind; redacting a message also blanks its lines in a thread's reminders and in the reminder events, keeping each event line's length) Turn it off for a thread with `remind <id> off-default` (or the inbox sheet), and everywhere with `FEEDBACK_DEFAULT_REMINDER=off`.

How it fires: the server (`react-feedback serve`) checks every thread each 60 seconds (`FEEDBACK_REMINDERS=off` stops that), and the CLI and the MCP server check the thread after each agent reply. A fire is recorded under the thread's lock with its `last_fired_at`, so a restart, or two processes at once, never fire it twice; and after a restart nothing fires on a thread that has had no activity since. When `reply` posts on a thread with open agent items and no `--check` or `--todo`, it prints a hint on **stderr** (stdout is unchanged): "N open items here; tick any you shipped with --check cN".

In the inbox: **Reminders** in the thread's ⋯ menu on a phone (a header button on a wide screen) opens a sheet that lists them, adds one (kind, value, text), removes one and switches the built-in one off. The sheet also keeps a **Fired** list with times; a fired reminder is not drawn in the thread itself. Read-only threads take reminders too, because they are for the agent. Over HTTP: `GET|POST api/threads/:id/reminders`, `POST …/reminders/default` (`{ "on": false }`), `DELETE …/reminders/:rid`; the thread detail carries `reminders_fired`.

## Connect your agents (MCP)

`react-feedback mcp` runs an [MCP](https://modelcontextprotocol.io) server on stdio, built on the official TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.2), so any MCP client can use the inbox. The tools call the same store the CLI uses (the same checks, limits and per-thread lock files, so a CLI and an MCP agent writing at once cannot corrupt a thread), never a shell.

Tools: `list_threads` (`waiting`, `area`, `q`), `read_thread` (marks it read for that agent; a capture's `capture` block has its selector, components and source), `reply` (`to`, `fyi`, `needs_you`, `done`, `todo[]`, `check[]`, `aside`, and an optional local `image` path), `ask`, `new_thread` (`read_only`), `todo_add`, `todo_check`, `tracker`, `merge`, `move`, `move_project` (the whole thread, to another project id; `dry_run` changes nothing; only when more than one project is configured), `ack`, `remind_add`, `remind_list`, `remind_remove`, `events_since` (poll the event feed with a cursor; no cursor means "from now", cursor `0` replays it; each event's `first_line` comes back as a `text` data field), `publish_artifact`, `list_artifacts`, `suggest_share` (asks the person; it does not create a link), `share_artifact` (`expires` of `1d`, `7d` or `30d`, default 7 days; pinned to the current version), `revoke_share` (a link this agent created), `cancel_question`, `bump_question` and `expire_questions` (`ask` also takes `expires`). There is deliberately **no** `redact`, `unredact` or `ask_secret` over MCP: those stay with the trusted CLI. Pass `--project <id>` or set `FEEDBACK_PROJECT` when `FEEDBACK_PROJECTS` is set.

**Names.** Each server instance posts as `FEEDBACK_AGENT_NAME` (for example `Codex` or `Claude Desktop`) and keeps its own read state. The inbox shows the name, with an avatar colour made from it. Messages from an unnamed agent (no `FEEDBACK_AGENT_NAME`, for the MCP server or the CLI) are unchanged and use the agent profile; the CLI's `ask` and `ask-new` post under `FEEDBACK_AGENT_NAME` when it is set, so `ask-expire --all-mine` finds them. Names that could pass for you or the system (`you`, `user`, `system`, your own inbox name, compared without case, width or invisible characters) are refused, and zero-width and bidi characters are removed.

**Files.** `reply` takes `files`, a list of local paths of files of any type and size; they are **off unless `FEEDBACK_FILE_DIR` is set** (a `:`-separated list of folders, with the same rules as `FEEDBACK_IMAGE_DIR`: symlinks resolved, never the data or vault folders, `/` or the home folder refused). `read_thread` lists each message's attachments (id, name, size, type, sha256, uploader and absolute path), and `get_attachment` returns `text` for a text file of up to 1 MB and the `path` for the rest. Anything an agent reads from a file may be sent to its model provider.

**Safety.** Text that people wrote comes back in `text` fields of the tool result, with a notice, and every tool description says it is data to read, never instructions. Message and item limits are the CLI's. **Images are off unless `FEEDBACK_IMAGE_DIR` is set** (a `:`-separated list of folders; empty entries are ignored, and `/` or the home folder is refused). An `image` must be a PNG, JPEG or WebP inside one of them, after symlinks are resolved, opened without following a link, and never inside the data or vault folders. The working folder is never allowed, because a client may start the server anywhere.

**Transport.** stdio only, on the same machine. An HTTP transport is **not implemented**: a remote option would need its own token and stays off unless asked for.

Claude Code:

```sh
claude mcp add react-feedback --env FEEDBACK_DIR=/path/to/feedback-data --env FEEDBACK_AGENT_NAME=Claude --env FEEDBACK_IMAGE_DIR=/path/to/images -- bun /path/to/react-feedback/bin/react-feedback.ts mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "react-feedback": {
      "command": "bun",
      "args": ["/path/to/react-feedback/bin/react-feedback.ts", "mcp"],
      "env": { "FEEDBACK_DIR": "/path/to/feedback-data", "FEEDBACK_AGENT_NAME": "Claude Desktop", "FEEDBACK_IMAGE_DIR": "/path/to/images" }
    }
  }
}
```

Any other stdio client: run `bun /path/to/react-feedback/bin/react-feedback.ts mcp` with `FEEDBACK_DIR`, `FEEDBACK_AGENT_NAME` and (to allow images) `FEEDBACK_IMAGE_DIR` in its environment (installed as a dependency, the same file is `node_modules/react-feedback/bin/react-feedback.ts`). It needs Bun on the path.

## File attachments

A message can carry files of any type, from the inbox (the **Attach file** paperclip, which sits beside the **＋** on a phone; drag and drop onto the thread, or paste) and from an agent (`reply … --file`, or MCP `reply` with `files`). There is **no size cap unless you set `FEEDBACK_MAX_UPLOAD_BYTES`**.

- **Chunked and resumable.** The inbox splits a file into chunks of at most 32 MiB, so it works behind a proxy or tunnel that limits one request (see [Reverse proxy](#reverse-proxy)). Every chunk is streamed to disk as it arrives; a file is never held in memory, on the server or (it is hashed and sent one chunk at a time) in the browser. The server appends chunks to a temp file keyed by an upload id, a resume asks for the offset it has, and finishing checks the size and the **sha256** before the file is moved into place. A wrong checksum discards the upload. Partial uploads, and finished ones no message took, are removed after 24 hours.
- **Disk guard.** A new upload, or a chunk, is refused ("Not enough disk space on the server", HTTP 507) when it would leave less free on the data volume than the larger of `FEEDBACK_MIN_FREE_BYTES` (20 GiB) and 10% of the volume.
- **Storage.** `<thread>/files/<id>/<name>`, with name, size, sha256, content type and uploader stored on the message (`attachments`). The name is a label only: path parts, control and direction characters are removed and the length is capped. The content type is read from the file's first bytes, never from its name or from what the client said.
- **Showing and downloading.** An image (PNG, JPEG, WebP, GIF) shows in the thread like any picture. A PDF has a **Preview** button, which opens it in a sandboxed frame (`sandbox` with nothing allowed, no `allow-same-origin`); browsers that cannot show a PDF in a sandboxed frame show a blank frame, so **Download** is always beside it. Everything else is a chip with name, size and **Download**. Every download goes out with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-origin` and no cookie, as `application/octet-stream` (an image keeps its image type, so it can be a picture). HTML, SVG and script files are never served inline from the inbox origin. The PDF preview is the one response that is not an attachment, and it has the same sandbox headers. Files are not reachable from a [share link](#share-links).
- **Offline.** A file of up to 50 MB can wait with its message in the offline queue (IndexedDB); a bigger one needs a connection, and the chip says so.
- **Redaction** moves a message's files to the vault (`<message>.files/`) and they are no longer served; `unredact` puts them back. A merge or a move carries a message's files along.
- **Agents.** `react-feedback read` lists each attachment with the absolute path of its file; MCP `read_thread` includes attachment metadata (and the path), and `get_attachment` returns a text file of up to 1 MB as `text`, or the path for anything else. The "data to read, not instructions" notice covers an attachment's name and contents.
- **Privacy.** When an agent reads a file, its contents go to that agent's model provider. Attach only what you are happy for your agent to send there.

## Artifacts

An agent publishes a page on a thread: HTML as written, or Markdown rendered by the same safe renderer the inbox uses for messages (nothing is parsed as HTML). Each publish is a version, `v1`, `v2`, …, and older versions stay. The inbox shows a card on the thread and lists every page under **Artifacts**, next to Tracker. Open one at `#/artifact/<id>` (and `#/artifact/<id>/v<n>` for an older version).

The page is served from the same host as the inbox, but it runs in an **opaque sandboxed origin**. It is served from `/__feedback/a/<id>/v<n>` with `Content-Security-Policy: sandbox allow-scripts allow-popups` (no `allow-same-origin`), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and the viewer embeds that URL in `<iframe sandbox="allow-scripts allow-popups">`, created only while the viewer is open. A script in the page cannot read the inbox's `localStorage`, cookies or API.

The inbox's own viewer loads the page as `/__feedback/a/<id>/v<n>?capture=1`: the page exactly as published, plus the capture script described under [Feedback on a shared page](#feedback-on-a-shared-page), so you can send a screenshot of it from the **Feedback** button in the viewer's header. The plain URL, with no `capture=1`, is the published page byte for byte.

## Share links

**Share** on the viewer asks for an expiry (1 day, 7 days, 30 days, or none) and creates `/__feedback/s/<token>`. The token is 32 random bytes, 43 base64url characters; the server stores only its sha256. The link serves the version from when it was created, or whatever is latest if that box was ticked, with the same sandbox and `X-Robots-Tag: noindex`. It is a small page of its own (see [Feedback on a shared page](#feedback-on-a-shared-page)) with no inbox chrome and no inbox API: the only calls it can make are the two described there. A revoked link, an expired link and an unknown token all answer with the same 404. Each view increments a counter and a last-viewed time. The address and the user agent are not stored. The token is in the URL, so it shows up in proxy and tunnel access logs; treat those logs as sensitive.

The card and the viewer show **Shared · 2 links · viewed 5×**. Manage lists each link as a card: who created it, when, the expiry, the version, the views and the last view, with Revoke on the right. The Artifacts page lists every active link, with Revoke.

An agent can create a link too (`artifact share`, `share_artifact`). The link is pinned to the version that is current when it is created. Its expiry defaults to 7 days and cannot be longer than 30. "No expiry", and a link that follows later versions, are only from the inbox. The link records who created it (`you`, or the agent's name). Creating one posts a line on the thread so it is visible at once, and the pill updates. Before the link is created, the page is scanned for things that look like secrets (API keys, private keys, tokens, passwords). A hit refuses the agent's link. The person can still share from the inbox after a warning. An agent can revoke only a link it created; the person can revoke any of them. `suggest_share` only shows **Share?** on the card.

A latest link keeps serving new versions. Publishing the next version runs that same scan on the new text and refuses the publish on a hit, so the new text is checked before it goes live. When the new version does go live, the thread gets a line: "New version vN is now live on a shared link".

The server treats HTTP callers as the person and CLI or MCP callers as agents, and loopback has no authentication. The guardrails apply to a cooperative agent using the CLI or MCP. An agent with shell access can call the HTTP API or edit the files itself; for a stronger split, run agents as a different OS user.

If the site in front of the server asks people to log in, let the share link through and keep the inbox, the API and `/__feedback/a/` behind the login. The link is unguessable; the rest of the server is not. A shared page makes exactly two more requests to the same address: `POST /__feedback/s/<token>/feedback` (a note, with or without a screenshot) and `POST /__feedback/s/<token>/replay` (a recording, only when the owner switched it on). Allow `GET` on the token and `POST` on those two paths, and nothing else. **0.12.0 needs no new public path:** a screenshot goes in the same `feedback` request (a `?image=1` query on that same path, which a path match ignores), and watching a recording live is done by the owner through the inbox API, which stays behind your login. Bun normalises dot segments, so a proxy that matches the raw prefix `/__feedback/s/` also passes `/__feedback/s/%2e%2e/api/threads` through to the API. Match the token itself with an anchored pattern, and keep every other path behind the login:

```caddyfile
@shared {
	method GET POST
	path_regexp ^/__feedback/s/[A-Za-z0-9_-]{43}(/(feedback|replay))?$
}
handle @shared {
	reverse_proxy 127.0.0.1:8099
}
handle {
	basic_auth {
		# the site login
	}
	reverse_proxy 127.0.0.1:8099
}
```

Check the exemption: `curl -i https://<host>/__feedback/s/%2e%2e/api/threads` must return **401**, and so must `curl -i -X POST https://<host>/__feedback/api/replays`. A real token is 43 characters; `{43}` is that length. The shared page sends its two POSTs as `text/plain` JSON, so the browser needs no preflight (`OPTIONS`) request. A note with a screenshot is a larger body (up to about 2.9 MB); if your proxy caps request bodies, allow that on `/__feedback/s/<token>/feedback`.

## Feedback on a shared page

A share link opens a small **shell** page that the package serves (package code only, no inbox chrome, no inbox API calls). It holds the artifact in the same sandboxed iframe as before (`sandbox="allow-scripts allow-popups"`, no `allow-same-origin`) and a **Feedback** button. The shell itself is sandboxed by its response header too (`Content-Security-Policy: sandbox allow-scripts allow-popups`), so neither it nor the artifact can read the inbox's storage, cookies or API.

A viewer can send a note of up to 4,000 characters, and can **point at** part of the page, or **capture** it (below). Pointing: a small helper inside the iframe reports the clicked element's text snippet (never from inside `[data-rf-private]`), a CSS path and a box relative to the viewport, by `postMessage`. The shell believes only messages whose `event.source` is its own iframe, and sends one `POST /__feedback/s/<token>/feedback`.

**Capture, with a screenshot.** The Feedback dialog also offers **Region**, **Element**, **Section** and **Full page**: the same capture as the widget in a host app (drag or tap a region, tap an element or its section, or the whole page), with a screenshot, **Draw on it** markup and a note. It works on a phone (touch to pick a region or an element). The capture runs **inside the artifact's iframe**, where the page is: the server adds one more inline script to the shared page (`dist/capture.js`, built from the widget's own capture and screenshot code, with React and the CSS inside) next to the existing helper. It does nothing until the shell asks, makes no request, does not touch the page's console or `fetch`, and reports back by `postMessage`: the picture (PNG, or a JPEG when a PNG would be too big), the mode, the rectangle, the CSS selector, a text snippet and, when the page is a React app that carries it, the component names and source location. **Anything inside `[data-rf-private]` is painted over in the picture and reports no text.** The shell believes only messages from its own iframe and checks every field (type, length, a real `data:image/png|jpeg;base64` URL) before sending anything; whatever does not fit is dropped. A capture too large for the 2 MB cap is downscaled in the page first. Nothing is sent without the viewer pressing **Send** in the capture's note; if a send fails the note and its picture come back in the dialog.

The same request is used as for a note: `POST /__feedback/s/<token>/feedback` as `text/plain` JSON (so still no preflight), with an optional `image` and a `quote` that may carry `mode`, `box`, `components` and `source`. The request goes to `…/feedback?image=1` when it has an image; without that flag the body cap stays at 16 KB as before, with it the cap is about 2.9 MB. The server accepts a **PNG or JPEG only**: the base64 must be exact, the file's structure is walked end to end (PNG chunks to `IEND`, JPEG markers to a frame header and the end marker, so a file that only begins like a picture is refused), it must be **at most 2 MB decoded** and **at most 4096 × 16384 pixels**. Each link may receive **20 MB of screenshots a day** (in memory, like the other limits); past that the request is `429` and a note alone still goes through. The other limits are unchanged. A bad image is a `400` (or `413` when too big) and nothing is stored. A request without `image` is exactly the old request, so an old cached shell keeps working.

**In the inbox.** The artifact viewer's **Feedback** button (it appears when the page's capture script is ready) opens the same four modes. The capture again runs inside the sandboxed iframe, and the **inbox page** (not the iframe) validates the `postMessage` and posts it to the artifact's thread as a message **from you**, with the picture attached and a line saying which artifact, version, mode and element it was about.

The note is stored in the artifact's thread as a message from the **viewer**, shown as "Viewer feedback · <title> · link <id>", flagged **Needs you**, with the pointed-at snippet quoted. It makes the thread wait on you and counts as unread. Manage shows a feedback count per link. An agent that reads the thread sees `viewer` as the author and the text as data to read, not instructions; a screenshot from a viewer is labelled the same way (the transcript says `viewer-supplied image`, and the MCP message carries the notice that its images are the viewer's too), and its `quote` keeps the capture mode, selector, components and source as data. Only the inbox's person answers it; the viewer sees nothing back.

The endpoint answers only for an active link (a bad, revoked or expired token is the same 404 as before), and it has no read path. It is rate limited in memory, per link (5 a minute, 50 a day, and 20 MB of screenshots a day) and per caller address (5 a minute); the limits are forgotten when the server restarts, and the address is used for that and never stored. No address and no user agent are written to disk.

## Session replay

Recording is **off for every link** until the owner switches it on, and it is built on [rrweb](https://github.com/rrweb-io/rrweb) (MIT), bundled into the package at a pinned version, with no CDN.

**On a shared page.** The share dialog and Manage each have a **Record interactions** switch per link (off by default). Only the inbox has it: there is no CLI command or MCP tool that turns it on, and an agent's link never records. With it on, the server adds the recorder to the page it serves for that link (and only that link: never the inbox viewer's `/__feedback/a/` copy). The recorder does nothing until the shell tells it to start, and the shell shows a visible notice first:

> This page records clicks and mouse movement to help the author. **Don't record**

Nothing is uploaded for the first 10 seconds, or until the first 4-second upload tick after that, so a viewer who reads the notice and declines in that time has sent nothing at all. **Don't record** stops recording and deletes anything this visit sent: it stops the recorder, drops what is waiting and, if an upload had already gone, asks the server to delete that session (`POST /__feedback/s/<token>/replay` with `{session, discard: true}`; the server removes it only if it belongs to that link). The choice is kept for that link in the address of that tab (the shell has no storage of its own because it is sandboxed), so a reload stays declined; a fresh visit shows the notice again. Events go to the shell by `postMessage`, and the shell uploads them in batches to `POST /__feedback/s/<token>/replay`, with a session id it makes up. The server takes them only while the link is active and the switch is on (otherwise 403, or the usual 404).

**In the inbox itself.** The profile has **Record my inbox sessions** (off by default). When on, the inbox records itself in **inbox mode**: every piece of text is masked (`maskTextSelector: '*'`), so only layout, clicks, mouse movement and scrolling are kept, and the share link, the key box, the redact dialog and the replay dialog are blocked outright and uploads to `POST api/replays`, and the sidebar footer shows **● Recording**. These are yours alone: they are listed under **Metrics, My sessions**.

**What is recorded.** The page's structure and what changes on it, clicks, mouse movement sampled every 50 ms, scrolling, and the window size. Every input is masked (`maskAllInputs`), so is the text of any `contenteditable` element, and anything inside an element marked `data-rf-private` is blocked. A session is at most 30 minutes and 5 MB; when it reaches either, the server refuses more and the page stops sending. It is stored as `_replays/<artifact>/<session>.jsonl.gz` (gzip, appended chunk by chunk) with a small `<session>.json` of metadata: link id, version, start, duration, click count and click positions. No address and no user agent are stored. Inbox sessions live in `_replays/_inbox/`.

**Phone.** While the inbox records, a small red dot also shows in the thread header at phone width, so the indicator is visible with a thread open.

**Watching them.** The artifact viewer has a **Replays** tab (date, duration, clicks, version, link) with **Play** and **Delete**, and a **Heatmap** toggle that draws every click on that version of the page, scaled to its width. **Play** opens rrweb-player, bundled and served by the package, with orange markers on the timeline at each click. The player page has a strict Content-Security-Policy (its own script only, no requests; images, fonts and media may load only from the player itself, `data:` and `blob:`, so **external images in a replay do not load**, and a crafted recording cannot beacon to another host), and rrweb rebuilds a recording only inside an iframe that runs no scripts, because anyone with a recording link can send crafted events.

**Watching live.** While a session is still recording, you can watch it as it happens. In the Replays tab (an artifact's, and **Metrics, My sessions**) a session that received a chunk in the last ~20 seconds shows **● Live** and a **Watch live** button; recorded sessions keep **Play**. The live view is the same player in rrweb's live mode, a few seconds behind (about one upload plus one poll), with a **LIVE** badge; it says **ENDED** once no chunk has arrived for about 30 seconds or the session has gone (a viewer who chose **Don't record** deletes it). The player page keeps its strict Content-Security-Policy and makes no request: **the inbox page, signed in, polls** `GET api/artifacts/:id/replays/:session?after=<n>` (or `GET api/replays/:session?after=<n>` for your own inbox sessions) every 2 seconds and passes the new events in by `postMessage`. The player believes only a message from the page that framed it, from its own origin, validates every event, and takes at most 5,000 events per message. `after` is an event count: the answer is `{meta, events, cursor, live}` with only the events after it (at most 5,000 a read) and the cursor to ask from next. The server records where each chunk starts in the gzip file (in the session's metadata), so a poll unpacks only the newest chunk, not the whole recording; a recording written before 0.12.0 is read from its start, capped at the session's 5 MB. **There is no public live endpoint**: a share link stays write-only, and live viewing does not change what is collected, what the viewer is told, **Don't record**, the masks or the caps. The owner can watch live; if you record visitors, that is part of what you tell them.

**Retention.** 30 days by default (`FEEDBACK_REPLAY_DAYS`). A pass at start and then daily removes sessions that have not been written to for that long. **Revoking a link** stops new recordings at once; recordings that exist stay until you delete them or they expire.

### Privacy

Recording clicks and mouse movement of people looking at a page is processing of their behaviour, and in many places (including UK and EU data protection law) people must be told. This feature mirrors that transparency duty: the notice is always shown, cannot be turned off by the page, and the viewer can opt out. **You, the owner, are responsible for telling people** who use your links, for having a reason to record, and for how long you keep recordings. This is not legal advice.

- Off by default, per link, and only the owner can switch it on.
- The notice is shown before anything is recorded, and **Don't record** stops recording and deletes anything this visit sent.
- Inputs are masked; `data-rf-private` content is not recorded.
- No IP address and no user agent are stored. The server sees the caller's address while it handles a request, uses it only for in-memory rate limits, and writes it nowhere.
- Recordings are deleted after the retention period, and you can delete any of them sooner.

## Projects

One server can host several projects. `FEEDBACK_PROJECTS` is a JSON list:

```json
[{"id": "app", "name": "App", "dir": "/data/app"}, {"id": "site", "name": "Site", "dir": "/data/site"}]
```

A project may also have a picture: `{"id": "app", "name": "App", "dir": "/data/app", "icon": "/data/app-logo.png"}`. `icon` is the path of a PNG, JPEG or WebP file of at most 1 MB, read on this server only; it is served at `/__feedback/api/projects/<id>/icon` and the path is never sent to a browser (`GET api/projects` only says `has_icon: true`). A missing, oversize or wrong file logs one warning at startup and the project keeps its badge. Without an icon every project gets a generated badge: up to two initials of its name on a colour taken from its id. The badge or picture shows on the project button, in each row of the menu and in the phone header.

Each project has its own threads, artifacts, shares, events and agents. Requests take `?project=<id>`. Leaving it off means the first project, so a single-project URL keeps working. When `FEEDBACK_PROJECTS` is unset there is one project (`FEEDBACK_DIR`, exactly as before) and `?project=` is ignored.

The project name is at the top of the sidebar (the top of the list on a phone). With two or more, it opens a menu of every project and its unread count. The last choice is remembered in this browser. One project hides the menu (and keeps the "Feedback inbox" heading, which two or more projects replace with the menu). The CLI and the MCP server take `--project <id>` or `FEEDBACK_PROJECT`; the default is the first project.

With two or more projects, a thread can move to another one: **Move to project…** in the thread's ⋯ menu (and the desktop button), `move-project <thread> <project-id> [--dry-run]`, or MCP `move_project`. The folder goes with its images, checklist, reminders and files. Artifacts and share links that belong to the thread go too, so an existing link keeps working and keeps its view count. Vault entries for redacted messages move into that project's area of the vault. A thread that was merged into this one moves with it. The id is kept when the target is not already using it; otherwise a new id is assigned and every reference (the merge, quotes, the vault key) is rewritten from one map. Both projects record a `moved` event, and the thread gets a system line, "Moved from" followed by the source project's name. The thread's artifacts take their session recordings with them (see [Session replay](#session-replay)); a link keeps its recording switch, while the inbox's own recordings and its recording switch stay with the project. A failure leaves the thread in the source. Doing it again finishes or changes nothing. One project hides the control, and the command refuses.

## Pinned questions

A question that still needs an answer is a bar above the composer: **Waiting for your answer**, the newest prompt, and **2 more** when several are open. When that is the only open question and it has up to four options, the options sit in the bar and a tap answers. Otherwise, tap the bar to answer there. `ask-cancel <id> <qid>` (MCP `cancel_question`) withdraws it. `ask-bump <id> <qid>` (MCP `bump_question`) asks it again at the bottom. The open thread picks either change up on the next poll. A withdrawn question collapses to one muted line, **Withdrawn · \<prompt\> · \<reason\>** (the reason only when one was given). A re-asked original collapses the same way, **Re-asked below** linking to the new copy. Options, Other and Submit are hidden, and the question leaves the pinned bar; **show** expands it read-only. A selection or Other text already entered is kept, with **Send as a message** (posts it as a normal reply quoting the question) and, when it was re-asked, **Use on the new copy**. Submitting after the question has gone does the same, instead of only an error under the composer.

An answer in the thread shows a chip, **↩ q109 · Build secret share links…**, which scrolls to that question. The same line is what `read` prints and what `_events.jsonl` stores as `first_line` (`q109 (Build secret share links…): Yes, build it`), so two answers are easy to tell apart. Answers already stored get the chip from their `question_id`; nothing is rewritten.

## Expiring questions

A question can lapse if nobody answers it. `ask <id> "prompt" --option ... --expires 2h` (also `ask-new`; MCP `ask` takes `expires`) accepts a length of time from now (`30m`, `2h`, `1d`, `2w`; at least a minute, at most a year) or an absolute time (`2026-12-01T09:00:00Z`, or a date, which is midnight UTC). The question stores it as `expires_at`.

- **Lazy.** Nothing runs on a timer: a read compares `expires_at` with the clock. An expired, unanswered question reads as **Expired**: it collapses to one muted line, **Expired · \<prompt\>**, like a withdrawn one (same **show**, and the same **Send as a message** for any answer already typed), and it leaves the pinned bar, the **Waiting on you** count and the unread marker. The first read after the expiry writes one `expired` event (author `system`) to `_events.jsonl`; there is never a second.
- **No answer after it.** Answering an expired question is a `409 This question expired`; the inbox turns that into the same kept-answer line. An answer given before the expiry stays an answer.
- **Ending a session.** `ask-expire <id> <qid>` expires one of your questions now, `ask-expire <id> --all-mine` all the open ones you asked on that thread, and `ask-expire --all-mine` on every thread; MCP `expire_questions` (`id`, `question`, `all_mine`) does the same. "Mine" means asked under your agent name (`FEEDBACK_AGENT_NAME`). A hook that runs when an agent's session ends can call it, so its questions do not sit waiting for a person who is answering no one.
- **Reading it.** `read` prints `[question q3 expires …]` or `[question q3 expired …: it no longer waits on the user]`; MCP shows `expires_at` and `expired: true`. A question with no expiry is unchanged. A re-ask (`ask-bump`) of an expired question is allowed; the new copy has no expiry.

## Quote replies

Any message can quote an earlier one in the same thread, WhatsApp style. A message may carry an optional `reply_to: "<message id>"`; old messages have none and nothing else changes (a quote is metadata only: it does not affect who is waiting, unread marks or ticks). The server returns 400 if `reply_to` is not a message of that thread. A merge keeps the links, renumbered with the messages.

- **Inbox, desktop:** hover or focus a message and press **Reply**, or focus it and press **R**. A quote bar (author, first line, ×) appears above the composer; Esc in the composer cancels it.
- **Inbox, phone:** swipe a message to the right; a visible Reply button is always shown on touch screens.
- A reply shows a compact quoted snippet (author and first line, or "Image"); tapping it scrolls to the original and highlights it. If the original is gone it reads "Original message unavailable".
- **CLI:** `reply <id> "text" --to <message-id>` (also on `ask`).

### Quote a bit of a message

Select words inside one message (a mouse, shift and arrow keys, or a long press on a phone) and a small popover offers **Quote**, with an optional note. On a desktop it sits beside the selection; on a phone it docks at the foot of the screen, clear of the system's own selection menu. **Quote** (or Enter in the note) puts `> selected words`, a blank line and your note in the composer, ready to edit; **Q** moves to the note when the popover is showing; Esc dismisses it.

The sent message carries `quote: { message_id, text }` (1 to 1000 characters, naming a message in the same thread; never a side question or a divider), drawn as a quote that names its author and jumps to the source message. The `> ` block at the top of the text is not drawn twice, and deleting it from the composer drops the quote. If the original is gone (a merge or a move left it behind) the words stay with "original message unavailable". `read` prints `[quoting m3, agent: "words"]`; MCP messages carry `quote`. Redacting the quoting message hides its quote too; unredact brings it back. It also works offline: the quote waits in the outbox with the message. (On a viewer's note, `quote` is still what they pointed at on a shared page.)

On the inbox page the launcher sits bottom-right (`data-position="bottom-right"`), with a clear strip under the composer so it never covers Send.

## Side questions (`/btw`)

Type `/btw your question` in the inbox composer (or press **B**, or use the **Side question** button) to ask something without disturbing the main thread. The message carries `aside: true`; the agent's answers are messages with `aside: true` and `reply_to` set to the question. Old messages have neither field.

- **Inbox:** each side question and its answers show as a compact, collapsible "Side question" bubble set apart from the main flow. It is collapsed once answered and open, with a "Waiting for agent" pill, until then.
- **Waiting:** the main flow's last-message logic ignores asides. A thread with an unanswered aside has `waiting: "agent"` (unless the main flow waits on you) and `waiting_aside: true` in its summary (the field is absent otherwise). `ack` clears it too.
- **CLI:** `reply <id> "text" --aside --to <aside-id>`; `list --waiting` marks threads with a side question waiting; `read` prints each aside indented under "Side question".
- A side answer takes no flag, and neither side can put a question or a quote in an aside. A merge keeps asides and their links.

## Last seen

Each side sees the other. The inbox's thread header shows a quiet line with each agent's last activity ("Agent · active 2 min ago"): relative under an hour, the time after that in the viewer's local zone, hidden when there is no data, and shown on read-only threads too. An agent sees the user's last visit ("You · last seen 2026-11-19 10:42 UTC") and the other agents, never itself.

- **Agent:** its latest action through the CLI or the MCP server (any command or tool call), kept per agent name (`FEEDBACK_AGENT_NAME` for the CLI as well, so the CLI and the MCP server under one name share an entry). Written at most every 5 seconds.
- **User:** the latest inbox page activity (page load, poll or a message sent), written at most once a minute.
- **Where:** one small file per writer in `<FEEDBACK_DIR>/_presence/`, timestamps and the agent name only (no address, browser or thread); never created in a folder that does not exist. `GET api/presence` returns `{ user: { at } | null, agents: [{ name, at }] }` (everything; the inbox shows only the agents). `react-feedback list` and `read` print the lines on **stderr**, like the other hints, so their output is unchanged; the MCP `list_threads` and `read_thread` return `presence` without the caller.

## Checklist items on replies

`reply <id> "text" --todo "item" [--todo "…"] [--for agent|user]` adds checklist items as part of the message (default: the agent's own list); `--check c3 [--check c4]` ticks items. The message stores `added_items` and `ticked_items`, and the inbox shows "Added to checklist" / "Ticked" lists inside the bubble, each item jumping to its row in the panel. Over HTTP a user message may carry `todo` (a list of texts) and `for`; `check` is refused with 403 because only the agent ticks. The whole message is checked first: nothing is written if an id or a text is wrong. Read-only threads still refuse the user's items.

## Typing in a merged-away thread

A thread that was merged into another stays readable, with its "Merged into <title> · Open" line at the top. Its composer stays **open**: what you send there is posted to the thread you merged it into (the server forwards it, with the line "Sent in <title> after the merge", and files and images go with it), a toast says "Sent to <title>", and the target opens. A note directly above the composer says so all the time: "This thread was merged into <title>. What you send goes there. · Open". Attach image and Attach file work the same way. A question in a merged-away thread stays read-only (it has no id on the target), so its card is disabled.

## Moving messages

`react-feedback move <from> <msg-id> [<msg-id> ...] --to <into>` moves messages (the user's too), with their images, original times and authors, into another thread, behind a "Moved from: …" divider. Each moved message leaves a "Moved to <title>" stub at its old spot (same id, so quotes of it still resolve). Quotes between moved messages are remapped; a quote of a message that stayed is dropped. Items a message added move with it. A question moves with its answer, and a side question with its answers. Dividers, merged threads, a read-only target (for user messages) and the same thread are refused. Both threads are locked; an interrupted move is finished by running the same command again. It logs a `move` event.

## Tracker

`#/tracker` in the inbox lists every checklist item across the threads that were not merged away, in For you, For the agent and Done recently (ticked in the last seven days, collapsible), with a donut for overall progress, filters by thread and by state, and a search box. Each item links to its row in its thread. The item rules are unchanged. `GET api/tracker?thread=&state=open|claimed|done&q=` returns the same data; the CLI prints it with `tracker`.

## Markdown

Message bodies render a safe GitHub-flavoured subset: headings (`#` to `####`), tables (with alignment, scrolling inside the bubble), nested and ordered lists, read-only task lists, blockquotes, rules, inline and fenced code, links (https, mailto and in-app only, opened in a new tab with `rel="noopener noreferrer"`), bold, italic, strikethrough and line breaks. No HTML is ever parsed: everything is built with `createElement` and `textContent`. Quote snippets, previews and the tracker show plain text; the CLI prints the raw text. The renderer is `server/inbox/markdown.js` (no dependency).

## Secure key box

`react-feedback ask-secret <id> --name openrouter --label "OpenRouter API key" --help-url https://openrouter.ai/keys` posts a message of kind `secret_request` (`{ name, label, help_url }`) that asks the user for a key. **No value is ever stored by the feedback server.**

- The inbox draws a password box in the message (autocomplete off, no browser storage, no `name`), with Save, a "Where to get this" link and the name of the slot it fills. It is not a `<form>`, so a browser has no password to offer to save.
- On Save, the **browser sends the value straight to your app**: `PUT <FEEDBACK_SECRET_TARGET with {name} filled in>` with `{"value": "…"}` and `Content-Type: application/json`, same origin only (`redirect: "error"`, so a redirect cannot carry it elsewhere). The target must be a relative path; the server refuses to start with an absolute URL, and the inbox refuses to send to one. The inbox learns the target from `GET /__feedback/api/config` (`{ secret_target, redact, version }`).
- On a 2xx the box is cleared and the inbox records only `saved` and the target's short `hint` (at most 8 characters, such as `…abcd`, read from the target's JSON reply) with `POST api/threads/:id/messages/:mid/secret`. The route refuses any other field, so a value cannot ride along. The message then reads "Saved ✓ · ends …abcd", stops asking for the user's attention, and logs a `secret` event (`<name> saved`, never a value) so the agent can carry on. On a non-2xx the box stays and shows the target's error text (`detail`, `error` or `message`). If the reply carries `check: "rejected"` the message says the provider rejected the key; `check` is recorded with the hint (`works` or `rejected`).
- With `FEEDBACK_SECRET_TARGET` unset the message says "Secure entry isn't set up on this server" and shows no box. Offline it says "Connect to save this key": a key is never queued or stored for later.
- The value never reaches the thread, `_events.jsonl`, any log, `localStorage` or the offline cache. It exists only in the input until your app has it.

Your app's route must accept the same-origin `PUT`, check its own authentication and Origin as it does for any write, and answer JSON such as `{ "hint": "…abcd" }`; it must never echo the value in an error.

## Redacting sensitive messages

If something private lands in a thread, redact it. The agent runs `redact <id> <message-id> [--reason "…"]`; the user opens the **⋯** on one of their own messages and chooses **Redact…** (the inbox only offers it when `FEEDBACK_VAULT_DIR` is set, and only on the user's own messages).

- The message's text, pictures and attached files move to the **vault** (the files to `<message>.files/`, and they are no longer served): `FEEDBACK_VAULT_DIR/<thread>/<message>.json`, a directory at `0700` and files at `0600`, written atomically. It must be outside `FEEDBACK_DIR` and is **never served over HTTP**.
- In the thread the message becomes `{ text: "", images: [], redacted: { at, by, reason?, key } }`, shown as "🔒 Redacted (sensitive)" with the time and who did it. Quotes and snippets of it show "🔒 Redacted". The image files are deleted from the thread folder; the text is removed from `thread.jsonl`, search, the API and the CLI; its first line is blanked in `_events.jsonl` in place (the line keeps its byte length, so anything following the file by offset stays in step). A first message that a thread repeats in `item.json` and `feedback.md` is blanked there too, and the copy a merge made in the other thread is redacted with it.
- A question's prompt and option labels are hidden the same way.
- **Restore** is CLI only: `unredact <id> <message-id>` reads the vault back (pictures return under new numbers) and removes the vault file. The inbox has no restore.
- Redaction works on read-only threads. Back up the vault separately; it is the only copy.

## Offline sending (inbox)

The inbox registers a small service worker (`sw.js`, scoped to the inbox path) that saves the page, its scripts, the thread list and each thread you opened. With no signal the inbox still opens and shows what you last saw, with an "Offline · showing what you last saw" banner. (Service workers need https or localhost.)

- Sending while offline, or when a send fails on the network, stores the message (text, pictures, files of up to 50 MB, `/btw` side questions and quote-replies) in an **IndexedDB outbox** and shows it in the thread with a clock and "Waiting to send". You can delete it before it sends.
- When the connection returns (the `online` event, or a retry with backoff) queued messages go out **in order**, one at a time; a failed one holds the ones behind it. Each carries a `client_id`, and the server stores a message with a given `client_id` once however often it arrives (a repeat answers 200 with the stored message). A message the server refuses (a thread that became read-only, say) is marked "Couldn't send" with Try again and Delete.
- The message keeps the time you wrote it as `written_at`, shown in the thread. `created_at` stays the time it arrived, so read ticks and acknowledgements stay right; a bad `written_at` (in the future, over 30 days old) is ignored.
- Read-only threads refuse to queue anything. Secret key entry is never queued. Nothing but ordinary messages is stored, and no pictures or secrets are cached by the service worker; a browser without IndexedDB keeps the queue in memory and says so. The saved copy of a thread is replaced the next time you are online and open it, so a message redacted since then disappears from it too.

## Phone layout

At 760 px and narrower the thread view is one slim header (← title, the checklist donut, **⋯** with Pin, Merge into…, Move to project… when there is more than one project, Mark done or Reopen, the version, and the read-only note), and a one-line composer: **＋** (Attach image, Side question), a paperclip (Attach file), an auto-growing text box (about five lines at most) and a send arrow. Enter adds a new line; Send is the button. Keyboard hints are hidden on touch screens (`(hover: none) and (pointer: coarse)`), the Feedback launcher hides while the composer has focus, and the page follows `visualViewport` so an open keyboard leaves the message list the remaining height, scrolled to the newest message. Wide screens keep the old layout.

## HTTP API

All under `/__feedback/`. With `FEEDBACK_PROJECTS` set, add `?project=<id>` (omit it for the first project). `GET healthz`; `GET|POST api/items` (the widget's capture endpoint); `GET api/items/:id/:file`; `GET|POST api/threads`, `GET api/threads/:id` (includes `artifacts`), `POST api/threads/:id/messages|status|read|answer|merge|move-project` (a message body may carry `reply_to`, the id of an earlier message in the same thread, or `quote` (`{message_id, text}`, a bit of text selected from one); an unknown id is a 400; `move-project` takes `{project}` and answers `{moved, id, project, from}`, and needs more than one project); `GET|POST|PATCH|DELETE api/threads/:id/checklist`; `GET|POST api/profile`; `GET|POST api/pins`; `GET api/areas`; `GET api/presence`; `GET api/metrics?window=24h|7d|all`; `GET api/tracker`; `GET|POST api/threads/:id/reminders`, `POST api/threads/:id/reminders/default`, `DELETE api/threads/:id/reminders/:rid`; `GET api/projects` (`[{id, name, unread}]`, never a directory); `GET api/artifacts` and `GET api/artifacts/:id`; `POST api/artifacts/:id/share` (`{expires: "1d"|"7d"|"30d"|"none", latest?, confirm?, record?}`); `GET api/shares`; `POST api/shares/:id/revoke`, `POST api/shares/:id/record` (`{on}`, the owner's recording switch), `GET api/artifacts/:id/replays`, `GET|DELETE api/artifacts/:id/replays/:session` (`GET` takes `?after=<events>` for a live read: `{meta, events, cursor, live}`), `live` on each row of `GET api/artifacts/:id/replays` and `GET api/replays`, `GET api/artifacts/:id/heatmap?version=n`, `GET|POST api/replay-settings` (`{record_inbox}`), `GET|POST api/replays`, `GET|DELETE api/replays/:session` (the owner's own inbox sessions; `GET` also takes `?after=`). A message body may also carry `aside: true`, `todo` and `for`, and `client_id` and `written_at` (an offline queue's id and writing time). Also: `GET api/config` (`version`, `secret_target`, `redact`); `POST api/threads/:id/messages/:mid/redact` (the user's own messages, when a vault is set); `POST api/threads/:id/messages/:mid/secret` (`{ status: "saved", hint? }` only). `GET /__feedback/a/:id/v:n` is the sandboxed page (`?capture=1` adds the capture script, for the inbox's own viewer). `GET /__feedback/s/:token` is a share link (the shell page). `POST /__feedback/s/:token/feedback` (optionally with `?image=1` and an `image`) and `POST /__feedback/s/:token/replay` are the two things a viewer can send, both `text/plain` or `application/json`. `GET /__feedback/replay/recorder.js`, `player.js`, `player.css` and `player` are the replay assets. `POST api/threads/:id/read` requires `Content-Type: application/json`, the same as the other writes. Files: `POST api/uploads` (`{name, size}`, answers `{id, offset, chunk}`), `PUT api/uploads/:id?offset=N` (a chunk of at most 32 MiB as `application/octet-stream`; `offset` must be what the server has, else 409), `GET api/uploads/:id` (`{offset, size, state}`, for a resume), `POST api/uploads/:id/finalise` (`{sha256}`), `DELETE api/uploads/:id`; a message or a new thread names finished uploads in `attachments: [id, ...]`; `GET api/threads/:id/attachments/:attachment` downloads one (`?inline=1` for a PDF preview).

A capture is `POST api/items` with a JSON body of at most 25 MiB: `{ note, mode: "region"|"element"|"section"|"page", target?, image, annotated?, context_image?, context }`. Notes are 1 to 10 000 characters; `image` must be a PNG data URL.

## Security notes

This is meant for **local or development use**. The server has **no authentication**, anyone who can reach it can read every capture (screenshots can contain whatever is on the page) and write threads. Do not expose it to the internet as it is. Bind it to `127.0.0.1`, or put authentication in front of it (a reverse proxy with basic auth or SSO, or a private network or tunnel with access control). A share link is the one path to let through that login. Match the 43-character token with the anchored pattern in [Share links](#share-links): Bun normalises a `%2e%2e` inside a prefix match into the API. Do not run it in production builds of your app: gate the widget behind a flag. Uploaded images are checked by signature and size, file names are fixed or generated, and all stored text is escaped in the inbox. The key box and the vault do not change that: they keep a key out of the thread, and a redacted message out of the served data, but they do not authenticate anyone. Anyone who can reach the server can still ask it to redact the user's messages. An artifact page is served from the same host but runs in an opaque sandboxed origin, so its scripts cannot read the inbox. A viewer's note and pointed-at text have escape sequences and control characters stripped, and an agent reading one through MCP gets a notice that it comes from a public viewer, not the user. A viewer of a share link can send a note and (only when the owner has switched it on) a recording; both are rate limited and size capped, neither can be read back through a link, and see [Privacy](#privacy). The server treats HTTP callers as the person and CLI or MCP callers as agents, and loopback has no authentication, so the agent guardrails bind a cooperative agent using the CLI or MCP. An agent with shell access can call the HTTP API or edit the files itself; for a stronger split, run agents as a different OS user.

## Development

```sh
bun install
bun run typecheck && bun run lint
bun run test        # vitest (widget and the inbox page in happy-dom) and bun test (server, store, CLI)
bun run test:e2e    # optional browser smoke test (needs Playwright and a built dist/)
bun e2e/rf6.mjs     # optional browser test: phone layout, key box, redaction, offline sending (same needs)
bun e2e/rf7.mjs     # optional browser test: thread reminders and agent names (same needs)
bun e2e/rf8.mjs     # optional browser test: reminders only in the sheet, last seen in the header (same needs)
bun e2e/rf9.mjs     # optional browser test: version footer and the update banner (same needs)
bun e2e/v09.mjs     # optional browser test: artifacts, share links, the sandbox, projects and pinned questions (same needs)
bun e2e/rf093.mjs   # optional browser test: a withdrawn or re-asked question keeps the answer being typed (same needs)
bun e2e/attach.mjs  # optional browser test: files in chunks through a proxy that refuses over 50 MB, progress, cancel, retry, PDF and zip chips, offline queue (same needs)
bun e2e/parity.mjs <older-source-tree> <data-folder>   # an older release and this one must say the same about a copy of your data
bun e2e/rf0100.mjs  # optional browser test: feedback on a shared page, session replay, the notice and opt-out, the heatmap (same needs)
bun run build       # rebuilds dist/: index.js, index.d.ts, feedback.css, embed.js, recorder.js, player.js, player.css
```

Commit `dist/` together with any change to `src/widget/` or `src/replay/`, because git installs use it as is. `bun run build` makes `dist/embed.js` (the drop-in widget), `dist/capture.js` (the capture script injected into a shared artifact), `dist/recorder.js`, `dist/player.js` and the library. `rrweb` and `rrweb-player` are pinned (`2.2.0`, MIT) in `devDependencies` and bundled into `dist/recorder.js` and `dist/player.js`; nothing is loaded from a CDN.

## Licence

MIT, see [LICENSE](LICENSE). The licences of the third-party code bundled into `dist/` (rrweb, rrweb-player and Svelte, postcss, fflate, mitt, React and others) are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
