# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-17

First public release. Native WeChat mini-programs only.

### Added

- **Manifest and WXML graph (m1).** Reads `app.json` pages and `tabBar` entries,
  both `subpackages` and `subPackages` (with `root` and `independent`), and the
  component registry from page/component `.json`, `component: true` files and
  app-level `usingComponents`. Resolves root-absolute, relative and npm
  specifiers through `miniprogram_npm/<pkg>` and `node_modules/<pkg>`. Parses
  WXML elements, lines, `wx:for` / `wx:for-item` / `wx:for-index` / `wx:key`,
  `wx:if`, slots and data bindings in attributes and text. Handler attributes
  are accepted in concatenated and colon form for `bind`, `catch`,
  `capture-bind`, `capture-catch` and `mut-bind`.
- **Script linking (m2).** Parses every `.js` file the project walk sees with
  acorn, module first and per-file script retry, and links `Page({...})` /
  `Component({methods})` handlers, `this.setData(...)` call sites and
  `wx.cloud.callFunction` calls to the graph. Literal `setData` objects
  contribute top-level and nested keys; a non-literal argument produces a
  `set_data` node with `keys: null`. Files that fail both parses and handler
  attributes without a matching method become warnings in `wxgraph stats`, and
  `stats` reports how many `.js` files were seen, parsed and unresolved. `.ts`
  sources are counted in the source stamp and warned as `unsupported_ts`, never
  silently dropped.
- **Impact resolution (m3).** Resolves `wx:for` aliases to data paths and closes
  the owned `rerenders` edge through host attributes and declared component
  properties. A hop that does not resolve produces no edge; `explain` prints
  every attempt with its status, and `impact` lists the failed hops that touch
  the target under `unresolved hop(s)`. `impact --up` walks the `includes` edges
  back through every caller.
- **Agent surface (m4).** MCP server over stdio (`wxgraph_impact`,
  `wxgraph_explain`, `wxgraph_search`, `wxgraph_stats`, `wxgraph_build`) that
  refuses a stale graph, a `/wxgraph` Skill, and a recorded terminal demo.
- **CLI.** `wxgraph init [dir]`, `wxgraph build [dir]`,
  `wxgraph impact <target> [--up] [--json] [-C dir]`, `wxgraph explain <edge>`,
  `wxgraph search <query>`, `wxgraph stats`, each with `-C`. Query commands
  recompute the source stamp before answering and fail with one line when the
  graph is missing or stale. `init` and a `build` run from a parent directory
  record the project in `.wxgraph/config.json`, so the documented quickstart
  works verbatim from the repository root.
- **Shipped demo.** `examples/demo`, a synthetic native mini-program with two
  main-package pages, one lowercase subpackage, a custom component with declared
  properties, both handler spellings, literal, nested and non-literal `setData`,
  and a cloud-function call. `docs/demo.svg` records the real CLI output, and
  `docs/demo-results.json` stores the run.
- CI (Node 22: install, typecheck, build, tests) and a tag release workflow that
  attaches the packed CLI and a `dist/` tarball with checksums to the GitHub
  release.

### Known limitations

- Native `.wxml` only; Taro, uni-app and kbone output are not analysed.
- `.js` sources only; `.ts` files are counted and warned, not analysed.
- No WXSS or layout edges, no cloud-function bodies, no WXML expression
  evaluation.
- No watch mode or incremental reindex.
