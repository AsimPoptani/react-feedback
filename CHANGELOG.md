# Changelog

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
