---
name: wxgraph
description: Trace render impact in a native WeChat mini-program (WXML + app.json + JS). Use before editing a component or page to learn which hosts include it, which data path feeds each property, and which setData calls re-render which WXML elements. Query the graph instead of grepping WXML/JS for a component name.
---

# wxgraph

`wxgraph` indexes a native mini-program into a semantic graph: pages and
subpackages from `app.json`, custom components, WXML elements, data bindings
(with `wx:for` aliases resolved), event handlers, `setData` call sites and
cloud-function calls. The one edge that matters is `rerenders`: a resolved
path from a `setData` key to a concrete WXML element, carrying `via` (`direct`
or `prop:<name>`).

## When to query instead of grepping

Query the graph when the question is about **render impact across files**:

- "I changed `components/price-card` — which pages include it and what breaks?"
- "Which `setData` calls re-render `<view class="edit-mask">`?"
- "Which data path feeds `price="{{...}}"` on this component tag?"
- "Does anything actually read `data.order.total`?"

Read the files directly when the question is local: what a single template
renders, or logic that touches no binding.

Grepping a component name returns every textual mention, including comments and
unrelated components with the same word; the graph returns only resolved edges
and tells you which hop failed when it cannot resolve one.

## How to call it

MCP config (stdlib transport, no daemon). Install the package first
(`npm install -g .` or `npm link` from the wxgraph checkout) so `wxgraph-mcp` is
on `PATH`:

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

Tools:

| tool | use it for |
| --- | --- |
| `wxgraph_impact` | blast radius of a page, component or element. Pass `json: true` for machines, `up: true` to walk the hosts that include it. |
| `wxgraph_explain` | every hop behind one `setData` site or element, including failed hops |
| `wxgraph_search` | find a node id by page/component id, element, handler, data path or `setData` key |
| `wxgraph_stats` | counts plus what the parser could not read |
| `wxgraph_build` | re-index after editing WXML/JSON/JS |

When you only know a name, call `wxgraph_search` first and pass the returned id
to `wxgraph_impact` or `wxgraph_explain`.

Every answering tool refuses a stale graph and replies with exactly one line:
`run wxgraph build`.

## Output shape

```
components/price-card  (component)  included by 2 hosts

├─ pages/cart/index.wxml:3  <price-card price="{{item.unitPrice}}">
│    ← data items[].unitPrice  (pages/cart/index.js)
│    └─ setData({items}) in onEdit  pages/cart/index.js:12  →  <view>  components/price-card.wxml:4  [via prop:price]
└─ pages/order/detail.wxml:3  <price-card price="{{order.total}}">
     ← data order.total  (pages/order/detail.js)
```

`[via prop:price]` means the re-render crosses into the component through the
`price` property. `[via direct]` means the element sits in the `setData` owner's
own template.

## Reading the answer correctly

- An edge exists only when every hop resolves: `setData` key → data path → host
  attribute → component property → child binding → element. A missing edge is
  honest silence, not proof that nothing re-renders.
- `unresolved_setdata` means the handler called `this.setData(patch)` with a
  non-literal argument. Read that handler by hand; the graph cannot enumerate
  keys it never saw.
- `impact` prints an `unresolved hop(s)` block for keys that failed to resolve
  against the target (`no_binding`, `unknown_property`, `no_child_binding`).
  That is the graph refusing to invent an edge, not an empty blast radius.
- Warnings from `wxgraph_stats` are part of the answer: `unresolved_file` means
  a `.js` file in the project failed both module and script parsing,
  `unresolved_handler` means a handler attribute names no method in that unit,
  and `unsupported_ts` means a `.ts` file was counted but not analysed.

## Limits (v0.1)

- Native `.wxml` only: no Taro/uni-app/kbone output.
- `.js` sources only; `.ts` files are counted and warned, not analysed.
- No WXSS/stylesheet edges, no cloud-function bodies (call sites only), no
  expression evaluation beyond data paths.
- No watch mode: re-run `wxgraph build` after edits.
