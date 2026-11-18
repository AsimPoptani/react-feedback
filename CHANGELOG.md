# Changelog

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
