import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { buildGraph, loadGraph, writeGraph } from "../src/graph/build";
import { resolveGraph } from "../src/graph/resolve";
import type {
  Graph,
  RerendersEdge,
  SetDataNode,
} from "../src/graph/schema";
import { computeImpact, computeImpactUp, explain, formatImpact, formatImpactUp } from "../src/query/impact";
import { formatSearch, searchGraph } from "../src/query/search";

const PAGE_SCRIPT = `Page({
  data: { items: [], editing: false },
  onEdit() {
    this.setData({ items: [] });
  },
  onRefresh(patch) {
    this.setData(patch);
  },
});
`;

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wxgraph-graph-"));
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(dir, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return dir;
}

async function withProject(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await makeProject(files);
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function rerenders(graph: Graph, viaPrefix?: string): RerendersEdge[] {
  return graph.edges.filter(
    (edge): edge is RerendersEdge =>
      edge.rel === "rerenders" &&
      (viaPrefix === undefined || edge.via.startsWith(viaPrefix)),
  );
}

function setDataNodes(graph: Graph): SetDataNode[] {
  return graph.nodes.filter((node): node is SetDataNode => node.kind === "set_data");
}

function propertyHopProject(childBinding: string): Record<string, string> {
  return {
    "app.json": JSON.stringify({ pages: ["pages/cart/index"] }, null, 2),
    "pages/cart/index.json": JSON.stringify(
      { usingComponents: { "price-card": "../../components/price-card" } },
      null,
      2,
    ),
    "pages/cart/index.wxml": [
      "<view>",
      '  <view wx:for="{{items}}" wx:for-item="item">',
      '    <price-card price="{{item.unitPrice}}" bind:edit="onEdit"></price-card>',
      "  </view>",
      "</view>",
    ].join("\n"),
    "pages/cart/index.js": PAGE_SCRIPT,
    "components/price-card.json": JSON.stringify({ component: true }, null, 2),
    "components/price-card.wxml": `<view class="price">${childBinding}</view>`,
  };
}

describe("rerenders through a custom-component property", () => {
  it("resolves setData -> data path -> host attribute -> child binding -> element", async () => {
    await withProject(propertyHopProject("{{price}}"), async (dir) => {
      const graph = await buildGraph(dir);
      const edges = rerenders(graph, "prop:");

      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        rel: "rerenders",
        element: "components/price-card.wxml:1:view",
        via: "prop:price",
        file: "pages/cart/index.js",
      });

      const call = setDataNodes(graph).find((node) => node.keys?.includes("items"));
      expect(call).toBeDefined();
      expect(edges[0].call).toBe(call?.id);

      // The alias in the template is resolved to the page data path.
      expect(
        graph.nodes.some(
          (node) =>
            node.kind === "data_field" &&
            node.owner === "pages/cart/index" &&
            node.path === "items[].unitPrice",
        ),
      ).toBe(true);

      const result = computeImpact(graph, "components/price-card");
      expect(result.hosts).toHaveLength(1);
      expect(result.hosts[0]).toMatchObject({ host: "pages/cart/index", tag: "price-card" });
      expect(result.hosts[0].passes).toContainEqual(
        expect.objectContaining({ attr: "price", path: "items[].unitPrice" }),
      );
      expect(result.rerenders).toContainEqual(
        expect.objectContaining({
          via: "prop:price",
          element: "components/price-card.wxml:1:view",
          elementTag: "view",
        }),
      );

      const rendered = formatImpact(result);
      expect(rendered).toContain("included by 1 hosts");
      expect(rendered).toContain("price=\"{{item.unitPrice}}\"");
      expect(rendered).toContain("[via prop:price]");
      expect(rendered).toContain("components/price-card.wxml:1");

      // Explain walks the same hops, including the child binding.
      const detail = explain(graph, call?.id ?? "");
      expect(detail).toContain('"items"');
      expect(detail).toContain("resolved [prop:price]");
      expect(detail).toContain("components/price-card.wxml");
      expect(detail).toContain("items[].unitPrice");
    });
  });

  it("emits no edge when the property hop is severed", async () => {
    await withProject(propertyHopProject("{{unitPrice}}"), async (dir) => {
      const graph = await buildGraph(dir);

      // The loop itself still re-renders; the property hop must not be guessed.
      expect(rerenders(graph)).toEqual([
        expect.objectContaining({ via: "direct" }),
      ]);
      expect(rerenders(graph, "prop:")).toEqual([]);

      const resolution = resolveGraph(graph);
      const severed = resolution.attempts.find(
        (attempt) => attempt.status === "no_child_binding",
      );
      expect(severed).toBeDefined();
      expect(severed?.detail).toContain('property "price"');

      const call = setDataNodes(graph).find((node) => node.keys?.includes("items"));
      const detail = explain(graph, call?.id ?? "");
      expect(detail).toContain("no edge (no_child_binding)");
      expect(detail).toContain('property "price"');

      const result = computeImpact(graph, "components/price-card");
      expect(result.rerenders).toEqual([]);
      const rendered = formatImpact(result);
      // The host and the property pass are still reported; only the guessed
      // re-render is absent.
      expect(rendered).toContain("included by 1 hosts");
      expect(rendered).toContain("price=\"{{item.unitPrice}}\"");
      expect(rendered).not.toContain("[via prop:");

      // The failed hop is part of the answer, not silent.
      expect(result.unresolvedHops).toContainEqual(
        expect.objectContaining({
          owner: "pages/cart/index",
          key: "items",
          status: "no_child_binding",
          handler: "onEdit",
        }),
      );
      expect(rendered).toContain("1 unresolved hop(s):");
      expect(rendered).toContain("no edge (no_child_binding)");
      expect(rendered).toContain('property "price"');
    });
  });
  it("refuses a property the child script does not declare", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/cart/index"] }, null, 2),
        "pages/cart/index.json": JSON.stringify(
          { usingComponents: { "price-card": "../../components/price-card" } },
          null,
          2,
        ),
        "pages/cart/index.wxml":
          '<view><price-card price="{{total}}"></price-card></view>',
        "pages/cart/index.js":
          "Page({\n  onLoad() {\n    this.setData({ total: 1 });\n  },\n});\n",
        "components/price-card.json": JSON.stringify({ component: true }, null, 2),
        // Declares `title` only, so the platform drops the `price` attribute.
        "components/price-card.js":
          'Component({\n  properties: { title: String },\n  methods: {\n    onTick() {\n      this.setData({ title: "x" });\n    },\n  },\n});\n',
        "components/price-card.wxml": "<view>{{price}}</view>\n<view>{{title}}</view>",
      },
      async (dir) => {
        const graph = await buildGraph(dir);
        expect(rerenders(graph, "prop:")).toEqual([]);

        const resolution = resolveGraph(graph);
        expect(
          resolution.attempts.find((attempt) => attempt.status === "unknown_property"),
        ).toMatchObject({ detail: expect.stringContaining('property "price"') });

        // Component({methods}) still yields handlers and setData sites.
        expect(graph.nodes).toContainEqual(
          expect.objectContaining({
            kind: "handler",
            id: "components/price-card:onTick",
          }),
        );

        // The component's own setData re-renders its own element.
        const result = computeImpact(graph, "components/price-card");
        expect(result.rerenders).toContainEqual(
          expect.objectContaining({ via: "direct", elementFile: "components/price-card.wxml" }),
        );
        expect(formatImpact(result)).toContain("own setData:");

        // The dropped attribute is reported against the host, not guessed.
        expect(result.unresolvedHops).toContainEqual(
          expect.objectContaining({
            owner: "pages/cart/index",
            key: "total",
            status: "unknown_property",
          }),
        );
        expect(formatImpact(result)).toContain("unresolved hop(s):");
        expect(formatImpact(result)).toContain("does not declare a property \"price\"");
      },
    );
  });

  it("resolves nested wx:for aliases back to the page data path", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/orders/index"] }, null, 2),
        "pages/orders/index.wxml": [
          '<view wx:for="{{orders}}" wx:for-item="row">',
          '  <text wx:for="{{row.cells}}" wx:for-item="cell">{{cell.price}}</text>',
          "</view>",
        ].join("\n"),
        "pages/orders/index.js":
          "Page({\n  onLoad() {\n    this.setData({ orders: [] });\n  },\n});\n",
      },
      async (dir) => {
        const graph = await buildGraph(dir);

        expect(
          graph.nodes.some(
            (node) =>
              node.kind === "data_field" &&
              node.path === "orders[].cells[].price",
          ),
        ).toBe(true);

        const edge = rerenders(graph).find((item) =>
          item.element.endsWith(":2:text"),
        );
        expect(edge).toMatchObject({
          via: "direct",
          element: "pages/orders/index.wxml:2:text",
        });
      },
    );
  });
});

describe("setData call sites", () => {
  it("keeps a non-literal argument as unresolved_setdata instead of guessing", async () => {
    await withProject(propertyHopProject("{{price}}"), async (dir) => {
      const graph = await buildGraph(dir);
      const site = setDataNodes(graph).find((node) => node.keys === null);

      expect(site).toBeDefined();
      expect(site).toMatchObject({ owner: "pages/cart/index" });
      expect(site?.line).toBeGreaterThan(0);

      expect(graph.edges).toContainEqual({
        rel: "calls_setdata",
        handler: "pages/cart/index:onRefresh",
        call: site?.id,
        file: "pages/cart/index.js",
        line: site?.line,
      });

      const result = computeImpact(graph, "pages/cart/index");
      expect(result.unresolvedSetData).toContainEqual({
        owner: "pages/cart/index",
        file: "pages/cart/index.js",
        line: site?.line,
        handler: "onRefresh",
      });

      const rendered = formatImpact(result);
      expect(rendered).toContain("unresolved_setdata");
      expect(rendered).toContain(`pages/cart/index.js:${site?.line}`);
      expect(rendered).toContain("in onRefresh");
    });
  });

  it("expands nested literal keys and follows a globally registered host", async () => {
    await withProject(
      {
        "app.json": JSON.stringify(
          {
            pages: ["pages/detail/index"],
            usingComponents: { "price-card": "/components/price-card" },
          },
          null,
          2,
        ),
        "pages/detail/index.wxml":
          '<view><price-card price="{{form.name}}"></price-card></view>',
        "pages/detail/index.js": `Page({
  data: { form: { name: "" } },
  onLoad() {
    this.setData({ form: { name: "" }, items: [] });
    wx.cloud.callFunction({ name: "pay" });
  },
});
`,
        "components/price-card.json": JSON.stringify({ component: true }, null, 2),
        "components/price-card.wxml": "<view>{{price}}</view>",
      },
      async (dir) => {
        const graph = await buildGraph(dir);
        const call = setDataNodes(graph).find((node) => node.keys !== null);

        expect(call?.keys).toEqual(["form", "form.name", "items"]);
        expect(rerenders(graph, "prop:")).toEqual([
          expect.objectContaining({
            element: "components/price-card.wxml:1:view",
            via: "prop:price",
          }),
        ]);

        expect(graph.nodes).toContainEqual({ kind: "cloud_fn", name: "pay" });
        expect(graph.edges).toContainEqual({
          rel: "invokes",
          from: "pages/detail/index:onLoad",
          to: "pay",
          file: "pages/detail/index.js",
          line: 5,
        });

        const result = computeImpact(graph, "components/price-card");
        expect(result.hosts).toHaveLength(1);
        expect(result.hosts[0].host).toBe("pages/detail/index");
      },
    );
  });
});

describe("handler attributes", () => {
  it("gives the colon spelling the same handles edge as the shorthand", async () => {
    const script = `Page({
  onTap() {
    this.setData({ done: true });
  },
});
`;
    await withProject(
      {
        "app.json": JSON.stringify(
          { pages: ["pages/short/index", "pages/colon/index"] },
          null,
          2,
        ),
        "pages/short/index.wxml": '<view><text bindtap="onTap">{{done}}</text></view>',
        "pages/short/index.js": script,
        "pages/colon/index.wxml": '<view><text bind:tap="onTap">{{done}}</text></view>',
        "pages/colon/index.js": script,
      },
      async (dir) => {
        const graph = await buildGraph(dir);
        const handles = graph.edges.filter((edge) => edge.rel === "handles");

        expect(handles).toHaveLength(2);
        expect(handles.map((edge) => [edge.event, edge.modifier, edge.handler])).toEqual([
          ["tap", "bind", "onTap"],
          ["tap", "bind", "onTap"],
        ]);

        // Both spellings attach to a real method, so neither warns.
        expect(graph.warnings).toEqual([]);
        expect(graph.nodes).toContainEqual(
          expect.objectContaining({
            kind: "handler",
            id: "pages/colon/index:onTap",
            owner: "pages/colon/index",
          }),
        );

        // The colon form re-renders through the same resolved path.
        for (const page of ["pages/short/index", "pages/colon/index"]) {
          const result = computeImpact(graph, page);
          expect(result.rerenders).toContainEqual(
            expect.objectContaining({ via: "direct", owner: page }),
          );
        }
      },
    );
  });

  it("warns about a handler with no matching method and never invents one", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "pages/index/index.wxml": '<view bindtap="onMissing">{{title}}</view>',
        "pages/index/index.js": "Page({\n  onPresent() {},\n});\n",
      },
      async (dir) => {
        const graph = await buildGraph(dir);

        expect(graph.warnings).toContainEqual(
          expect.objectContaining({
            code: "unresolved_handler",
            file: "pages/index/index.wxml",
            line: 1,
          }),
        );
        expect(graph.warnings[0].message).toContain("onMissing");
        expect(
          graph.nodes.some(
            (node) => node.kind === "handler" && node.name === "onMissing",
          ),
        ).toBe(false);
      },
    );
  });
});

describe("script parsing", () => {
  it("parses ES modules and reports files that fail both modes", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "pages/index/index.wxml": '<view bindtap="onTap">{{title}}</view>',
        "pages/index/index.js": [
          'import { helper } from "./helper";',
          "Page({",
          "  onTap() {",
          "    helper();",
          "    this.setData({ title: 'ok' });",
          "  },",
          "});",
        ].join("\n"),
      },
      async (dir) => {
        const graph = await buildGraph(dir);
        expect(graph.warnings).toEqual([]);
        expect(graph.nodes).toContainEqual(
          expect.objectContaining({ kind: "handler", name: "onTap" }),
        );
        expect(setDataNodes(graph)[0].keys).toEqual(["title"]);
      },
    );

    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "pages/index/index.wxml": "<view>{{title}}</view>",
        "pages/index/index.js": 'import { x } from "./x";\nconst = 1;\n',
      },
      async (dir) => {
        const graph = await buildGraph(dir);
        const warning = graph.warnings.find((item) => item.code === "unresolved_file");
        expect(warning).toBeDefined();
        expect(warning?.file).toBe("pages/index/index.js");
        expect(warning?.message).toContain("module:");
        expect(warning?.message).toContain("script:");
      },
    );
  });
});

describe("script coverage counters", () => {
  it("counts every .js file and warns about .ts sources it cannot analyse", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "pages/index/index.wxml": "<view>{{title}}</view>",
        "pages/index/index.js":
          "Page({\n  onTap() {\n    this.setData({ title: \"x\" });\n  },\n});\n",
        // A helper no unit owns: still parsed, still counted.
        "utils/math.js": "export const add = (a, b) => a + b;\n",
        // No unit owns this one either, and it does not parse: a reported gap.
        "utils/helper.js": "function broken( {\n",
        "utils/format.ts": "export const fmt = (v: number) => String(v);\n",
      },
      async (dir) => {
        const graph = await buildGraph(dir);

        expect(graph.stats).toMatchObject({
          js_files: 3,
          js_parsed: 2,
          js_unresolved: 1,
          ts_files: 1,
        });
        expect(graph.warnings).toContainEqual(
          expect.objectContaining({ code: "unresolved_file", file: "utils/helper.js" }),
        );
        expect(graph.warnings).toContainEqual(
          expect.objectContaining({ code: "unsupported_ts", file: "utils/format.ts" }),
        );
        // .ts sources are inside the stamp, so editing one invalidates the graph.
        expect(graph.stamp?.files).toBe(6);
        // Parsing a helper never invents nodes for it.
        expect(
          graph.nodes.some(
            (node) => node.kind === "handler" && node.owner === "utils/math",
          ),
        ).toBe(false);
      },
    );
  });
});

describe("caller walk", () => {
  it("walks includes edges upward through intermediate components", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/home/index"] }, null, 2),
        "pages/home/index.json": JSON.stringify(
          { usingComponents: { "card-shell": "../../components/card-shell" } },
          null,
          2,
        ),
        "pages/home/index.wxml":
          '<view><card-shell label="{{title}}"></card-shell></view>',
        "components/card-shell.json": JSON.stringify(
          { component: true, usingComponents: { "price-card": "./price-card" } },
          null,
          2,
        ),
        "components/card-shell.wxml":
          '<view><price-card price="{{label}}"></price-card></view>',
        "components/price-card.json": JSON.stringify({ component: true }, null, 2),
        "components/price-card.wxml": "<text>{{price}}</text>",
      },
      async (dir) => {
        const graph = await buildGraph(dir);
        const result = computeImpactUp(graph, "components/price-card");

        expect(result.dependents).toEqual([
          expect.objectContaining({
            id: "components/card-shell",
            kind: "component",
            depth: 1,
            tag: "price-card",
            file: "components/card-shell.wxml",
            line: 1,
          }),
          expect.objectContaining({
            id: "pages/home/index",
            kind: "page",
            depth: 2,
            tag: "card-shell",
            file: "pages/home/index.wxml",
            line: 1,
          }),
        ]);

        const rendered = formatImpactUp(result);
        expect(rendered).toContain("reached from 2 unit(s): 1 direct host(s), 2 level(s) up");
        expect(rendered).toContain("via <card-shell>");

        // A page nobody includes has no callers.
        expect(formatImpactUp(computeImpactUp(graph, "pages/home/index"))).toContain(
          "(no unit includes this target)",
        );
      },
    );
  });
});

describe("search", () => {
  it("finds nodes by id, path, tag and setData key", async () => {
    await withProject(propertyHopProject("{{price}}"), async (dir) => {
      const graph = await buildGraph(dir);

      const byPath = searchGraph(graph, "unitprice");
      expect(byPath.hits).toContainEqual(
        expect.objectContaining({
          kind: "data_field",
          id: "pages/cart/index:items[].unitPrice",
        }),
      );

      const byTag = searchGraph(graph, "price-card");
      expect(byTag.hits.map((hit) => hit.kind)).toEqual(
        expect.arrayContaining(["component", "element"]),
      );

      expect(formatSearch(byPath)).toContain('1 match for "unitprice"');
      expect(searchGraph(graph, "no-such-node").total).toBe(0);
    });
  });
});

describe("graph stamp", () => {
  it("answers only while the written graph matches its sources", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "pages/index/index.wxml": "<view>{{title}}</view>",
      },
      async (dir) => {
        expect((await loadGraph(dir)).status).toBe("missing");

        const graph = await writeGraph(dir);
        expect(graph.stamp?.files).toBe(2);

        const fresh = await loadGraph(dir);
        expect(fresh.status).toBe("ok");
        if (fresh.status === "ok") {
          expect(fresh.graph.stats.pages).toBe(1);
        }

        const pageFile = path.join(dir, "pages/index/index.wxml");
        await writeFile(pageFile, await readFile(pageFile, "utf8") + "\n", "utf8");

        const stale = await loadGraph(dir);
        expect(stale.status).toBe("stale");
        if (stale.status === "stale") {
          expect(stale.reason).toContain("sources changed");
        }
      },
    );
  });
});
