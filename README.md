**English** | [简体中文](./README.zh-CN.md)

<p align="center">
  <a href="https://github.com/SuperMarioYL/wxgraph">
    <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=22&pause=1200&color=6E56CF&center=true&vCenter=true&width=860&lines=Which+pages+re-render+when+this+component+changes%3F;setData+%E2%86%92+data+field+%E2%86%92+property+%E2%86%92+WXML+element;resolved+edges+only%2C+each+with+file%3Aline" alt="wxgraph: which pages re-render when this component changes? setData to data field to property to WXML element. Resolved edges only, each with file:line." />
  </a>
</p>

<h3 align="center">A semantic code graph for native WeChat mini-programs</h3>

<p align="center">
  One CLI, one MCP server and a <code>/wxgraph</code> Skill that answer the question an agent cannot answer by reading files:<br/>
  <em>if I change this component, what re-renders, through which <code>setData</code>?</em><br/>
  Free and open source (MIT), no paid tier.
</p>

<p align="center">
  <a href="https://github.com/SuperMarioYL/wxgraph/actions/workflows/ci.yml"><img src="https://github.com/SuperMarioYL/wxgraph/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-6e56cf.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-22%2B-3c873a?logo=node.js&logoColor=white" alt="Node 22 or newer" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white" alt="TypeScript 5.9" />
  <a href="#mcp-server"><img src="https://img.shields.io/badge/MCP-stdio-6e56cf" alt="MCP over stdio" /></a>
  <img src="https://img.shields.io/badge/daemon-none-brightgreen" alt="No daemon" />
</p>

---

## Why WXML needs its own graph

A mini-program is not just JSON and JavaScript. The render behaviour lives in
`.wxml` templates: `{{item.unitPrice}}` is fed by a data field, `bind:edit="onEdit"`
is a handler owned by a page or component, and `<price-card price="{{...}}">`
crosses a component boundary through a declared property. `app.json` adds
subpackage routing; `usingComponents` adds a component registry expressed three
different ways (root-absolute, relative, npm specifier).

Code-graph tooling generally has no WXML grammar, so a mini-program indexes as
loose JSON and JS. That graph looks populated and misses the only edges that
explain a render: which field feeds which binding, which handler owns the
`setData`, and which element re-renders afterwards. Grep returns every textual
mention; it does not return a path through those hops.

wxgraph parses the manifest, the templates and the scripts, then resolves them
into one graph. The owned edge is `rerenders`: a `setData` key resolved through
a data path, a host attribute and (when the value crosses a component boundary)
a declared property, down to a concrete WXML element. Every edge carries
`file:line` provenance. When a hop does not resolve, no edge is emitted, and
`impact` / `explain` print the failed hop instead of guessing.

## Quickstart

Requires Node 22 or newer. The repository ships a small synthetic mini-program in
`examples/demo` so the first result is one command away.

```bash
git clone https://github.com/SuperMarioYL/wxgraph.git
cd wxgraph
npm ci
npm run build
npm link                 # puts `wxgraph` and `wxgraph-mcp` on your PATH
cd examples/demo
wxgraph build
wxgraph impact components/price-card
```

`wxgraph build` indexes the project and writes the graph:

```text
1 subpackage · 3 pages · 1 component · 19 wxml nodes · 57 edges · 34ms
wrote .wxgraph/graph.json
```

`wxgraph impact` answers the blast-radius question from the graph:

```text
components/price-card  (component)  included by 2 hosts

├─ pages/cart/index.wxml:5  <price-card editing="{{editing}}" price="{{item.unitPrice}}">
│    ← data editing  (pages/cart/index.js)
│    ← data items[].unitPrice  (pages/cart/index.js)
│    ├─ setData({items, editing}) in onEdit  pages/cart/index.js:20  →  <text>  components/price-card.wxml:2  [via prop:price]
│    └─ setData({items, editing}) in onEdit  pages/cart/index.js:20  →  <view>  components/price-card.wxml:4  [via prop:editing]
└─ pages/order/detail.wxml:4  <price-card price="{{order.total}}">
     ← data order.total  (pages/order/detail.js)
     ├─ setData({order, order.no, order.total}) in onLoad  pages/order/detail.js:11  →  <text>  components/price-card.wxml:2  [via prop:price]
     └─ setData({order.total}) in onEditPrice  pages/order/detail.js:17  →  <text>  components/price-card.wxml:2  [via prop:price]

1 unresolved_setdata site(s):
  pages/cart/index.js:12 in onLoad  this.setData(<non-literal>)
```

Counts and `file:line` values are stable for the shipped demo; the build timing
depends on the machine. The full recorded run, including `--json`, is in
[`docs/demo-results.json`](./docs/demo-results.json).

If your global npm prefix is not writable, skip `npm link` and replace `wxgraph`
with `node ../../dist/cli.js` in the last two commands.

## Demo

![Terminal recording: wxgraph build examples/demo reports one subpackage, three pages, one component, 19 WXML nodes and 57 edges. Then wxgraph impact components/price-card lists two host templates and the two component nodes re-rendered by onEdit's setData: the price text via prop:price and the edit mask via prop:editing.](./docs/demo.svg)

Reading the answer:

- **Host lines** are the templates that include `components/price-card`. `pages/cart/index.wxml:5`
  passes two properties; `pages/order/detail.wxml:4` passes one.
- **`← data …`** is the page data path that feeds the property after `wx:for`
  aliases are resolved (`item.unitPrice` becomes `items[].unitPrice`).
- **`setData({…}) in <handler>`** is one resolved re-render, with the call site and
  the element it re-renders. `[via prop:price]` means the value crossed the
  component's declared `price` property; `[via direct]` means the element sits in
  the `setData` owner's own template.
- **`unresolved_setdata`** is not an error and not a guessed edge: `onLoad` passes
  a non-literal object to `this.setData`, so the graph records the call site and
  says which keys it cannot know.

## How it works

```text
app.json + *.json ─┐
*.wxml ────────────┼→ parse (manifest | wxml | acorn module→script) → resolve → .wxgraph/graph.json
*.js ──────────────┘                                                          │
                                                                              ├→ wxgraph CLI
                                                                              └→ wxgraph-mcp (stdio)
```

Six node kinds and eight edge kinds cover the model:

| Node | What it records |
| --- | --- |
| `page` / `component` | unit id, template path, declared component properties |
| `element` | WXML tag, line, owning template, `wx:for` scope |
| `data_field` | normalised path, e.g. `items[].unitPrice` |
| `handler` | method name, owning unit, line |
| `set_data` | call line and literal keys (`null` when the argument is not an object literal) |
| `cloud_fn` | cloud-function name from a `wx.cloud.callFunction` call site |

Edges are `contains`, `includes`, `in_subpackage`, `binds`, `handles`,
`calls_setdata`, `invokes`, and the owned `rerenders`. There is no daemon, no
network call and no database: the graph is a JSON file with a source stamp.

Scripts are parsed as ES modules first and retried as classic scripts per file,
because mini-program pages are commonly modules while utility files are commonly
scripts. A file that fails both parses becomes an `unresolved_file` warning in
`wxgraph stats`, never a silent gap.

## Usage

```bash
wxgraph build [dir]              # index a mini-program; writes .wxgraph/graph.json
wxgraph impact <target>          # what re-renders when this changes
wxgraph impact <target> --json   # structured result for machines
wxgraph impact <target> -C dir   # query a project other than the cwd
wxgraph explain <edge>           # every hop behind one setData site or element
wxgraph stats                    # counts plus what the parser could not read
```

`<target>` accepts a unit id (`components/price-card`), a template path
(`components/price-card.wxml`), or an element id
(`components/price-card.wxml:4:view`). `<edge>` accepts a `set_data` node id
(`pages/cart/index:20`), a `file:line` call site (`pages/cart/index.js:20`), or
an element id. `explain` prints the resolved hops and the failed ones with their
status: `non_literal`, `no_binding`, `unknown_property`, `no_child_binding`.

Query commands verify the graph stamp before answering. A missing or stale graph
is refused with one line:

```text
wxgraph: graph is stale (sources changed since the last build) — run wxgraph build
```

**Exit codes.** `0` on success. `1` for an expected runtime failure — missing or
stale graph, unknown target, unreadable `app.json`. Those failures are one line
on stderr prefixed `wxgraph:`, with no stack trace. Command-parser errors (an
unknown command or option) also exit `1`.

### MCP server

`wxgraph-mcp` serves the graph over stdio and refuses a stale graph the same way
the CLI does. Any MCP client works — Gemini CLI, Cursor, or your own agent loop.
After `npm link` (or `npm install -g .`), point the client at the binary:

```json
{
  "mcpServers": {
    "wxgraph": {
      "command": "wxgraph-mcp",
      "args": ["--project", "/absolute/path/to/miniprogram"]
    }
  }
}
```

| Tool | Use it for |
| --- | --- |
| `wxgraph_impact` | blast radius of a page, component or element; `json: true` for machines |
| `wxgraph_explain` | every hop behind one `setData` site or element, including failed hops |
| `wxgraph_stats` | counts, warnings, unreadable files, unresolved components |
| `wxgraph_build` | re-index after editing WXML, JSON or JS |

The same routing logic is packaged as a Skill: copy `skills/wxgraph` into your
agent's skills directory (for example `cp -r skills/wxgraph .claude/skills/`) and
the agent gets one instruction — query the graph before grepping nine templates.

## What v0.1 covers

Implemented, and exercised by the test suite:

- <img src="https://api.iconify.design/tabler/file-code.svg?color=%236e56cf&height=16" alt="" /> **Manifests.** `app.json` pages, `tabBar` entries, both `subpackages` and
  `subPackages`, each entry's `root` and `independent` flag.
- <img src="https://api.iconify.design/tabler/braces.svg?color=%236e56cf&height=16" alt="" /> **Component registry.** Page/component `.json` `usingComponents`, every file
  marked `component: true`, and app-level `usingComponents`. Specifiers resolve
  as root-absolute, relative, or npm specifier under `miniprogram_npm/<pkg>` with
  a `node_modules/<pkg>` fallback.
- <img src="https://api.iconify.design/tabler/code.svg?color=%236e56cf&height=16" alt="" /> **Templates.** Elements with tag and line, `wx:for` / `wx:for-item` /
  `wx:for-index` / `wx:key`, `wx:if`, slots, bindings in attributes and text,
  and nested loops. Handler attributes in both spellings — concatenated
  (`bindtap`, `catchtap`) and colon (`bind:tap`, `catch:tap`,
  `capture-bind:tap`, `capture-catch:tap`, `mut-bind:tap`) — normalise to the
  same `handles` edge with the bare event and the modifier kept separately.
- <img src="https://api.iconify.design/tabler/terminal-2.svg?color=%236e56cf&height=16" alt="" /> **Scripts.** `Page({...})`, `Component({ methods: {...} })`, handler methods,
  literal and nested-literal `setData` keys, non-literal `setData` sites,
  declared component `properties`, and `wx.cloud.callFunction` call sites.
- <img src="https://api.iconify.design/tabler/route.svg?color=%236e56cf&height=16" alt="" /> **Impact.** `setData` key → data path → host attribute → component property →
  child binding → element, closed only when every hop resolves.

Not in v0.1 — stated so the graph's silence is not mistaken for an answer:

- Native `.wxml` projects only. Taro, uni-app and kbone compiled output are not
  analysed.
- `.js` sources only. `.ts` files are not analysed.
- No WXSS or layout edges.
- Cloud-function bodies are not parsed; only call sites are recorded.
- WXML expressions are read for data paths, not evaluated. Ternaries and method
  calls are not computed.
- A resolved edge does not prove a runtime render: a `wx:if` guard can still be
  false. The graph reports the structural path; the platform decides.
- No watch mode or incremental reindex. Re-run `wxgraph build` after edits.

## Roadmap

`0.1.0` ships the full v0.1 pipeline: the manifest and WXML graph, script
linking, the resolved `rerenders` closure with `impact` and `explain`, and the
agent surface (MCP server, Skill, recorded demo).

Next candidates, in the order they unblock real-repo use:

- A fixture corpus from real native mini-programs, starting with the templates
  the current tests do not cover.
- `.ts` page and component sources.
- A JSON Schema for `graph.json` so other tools can consume the graph without
  vendoring the model.
- Watch mode on top of the existing source stamp.

Explicitly not planned: a hosted service, a web UI, accounts or telemetry.
v0.1 is a local tool with a query surface.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/cli.js, dist/mcp/server.js
npm test            # vitest run
```

The test suite covers the parsers, the graph builder, the property-hop resolver,
the stale-stamp contract, and the shipped demo's CLI output. `examples/demo` is
part of the contract: the CLI tests build it and assert the impact tree.

## License

MIT. See [LICENSE](./LICENSE).

<p align="center"><sub><a href="./LICENSE">MIT</a> © 2026 SuperMarioYL</sub></p>
