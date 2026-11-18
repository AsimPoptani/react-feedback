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

`endpoint` is the base URL of the feedback server and defaults to `/__feedback`. To ship it only in development, render it behind your own flag and lazy-load it:

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

`dist/embed.js` is a standalone bundle (React and the CSS are inside it). The server also serves it at `/__feedback/embed.js`, and the inbox loads it, so you can capture feedback about the inbox itself. `data-endpoint` defaults to `/__feedback`.

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
| `FEEDBACK_INBOX_WIDGET` | on | set to `0`, `off`, `false` or `no` to keep the capture widget off the inbox page itself |

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

`/__feedback/inbox/` lists threads grouped by area. By default an area is the first segment of the page path they were taken on (`/billing/plans` goes under "Billing", `/` under "Home", threads started without a capture under "Conversations"); see [Inbox areas](#inbox-areas) to name and group them yourself. It shows status pills and unread dots, a thread view with the original capture and message bubbles, a composer (Cmd/Ctrl+Enter sends, paste or attach images), checklists for the person and the agent, pins, merging, a read-only "updates" thread type, and a **Metrics** page (velocity, response times, workload, by-area table). Press `?` for the inbox shortcuts. Text is escaped; only bold, italics, inline code, `-` lists and http links are rendered.

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
react-feedback reply <id> "text" [--image a.png --image b.jpg]
react-feedback new "title" "text" [--image path ...]            # an agent-started thread
react-feedback status <id> open|done
react-feedback read <id>                                        # stamp the agent read marker
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
```

## HTTP API

All under `/__feedback/`. `GET healthz`; `GET|POST api/items` (the widget's capture endpoint); `GET api/items/:id/:file`; `GET|POST api/threads`, `GET api/threads/:id`, `POST api/threads/:id/messages|status|read|answer|merge`; `GET|POST|PATCH|DELETE api/threads/:id/checklist`; `GET|POST api/profile`; `GET|POST api/pins`; `GET api/areas`; `GET api/metrics?window=24h|7d|all`.

A capture is `POST api/items` with a JSON body of at most 25 MiB: `{ note, mode: "region"|"element"|"section"|"page", target?, image, annotated?, context_image?, context }`. Notes are 1 to 10 000 characters; `image` must be a PNG data URL.

## Security notes

This is meant for **local or development use**. The server has **no authentication**, anyone who can reach it can read every capture (screenshots can contain whatever is on the page) and write threads. Do not expose it to the internet as it is. Bind it to `127.0.0.1`, or put authentication in front of it (a reverse proxy with basic auth or SSO, or a private network or tunnel with access control). Do not run it in production builds of your app: gate the widget behind a flag. Uploaded images are checked by signature and size, file names are fixed or generated, and all stored text is escaped in the inbox.

## Development

```sh
bun install
bun run typecheck && bun run lint
bun run test        # vitest (widget) and bun test (server, store, CLI)
bun run build       # rebuilds dist/: index.js, index.d.ts, feedback.css, embed.js
```

Commit `dist/` together with any change to `src/widget/`, because git installs use it as is.

## Licence

MIT, see [LICENSE](LICENSE).
