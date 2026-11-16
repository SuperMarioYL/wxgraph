import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildGraph, writeGraph } from "../src/graph/build";
import type { UnitNode } from "../src/graph/schema";
import {
  readAppManifest,
  resolveComponentSpecifier,
} from "../src/parse/manifest";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/demo-mini", import.meta.url));

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wxgraph-test-"));
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

describe("app.json", () => {
  it("reads lowercase subpackages, tabBar entries and global components", async () => {
    const manifest = await readAppManifest(FIXTURE_DIR);

    expect(manifest.pages).toEqual(["pages/cart/index", "pages/order/detail"]);
    expect(manifest.tabBarPages).toEqual(["pages/cart/index", "pages/order/detail"]);
    expect(manifest.subpackages).toHaveLength(1);
    expect(manifest.subpackages[0]).toMatchObject({
      root: "packageA",
      pages: ["packageA/pages/list/index"],
      independent: true,
    });
    expect(manifest.usingComponents).toHaveLength(1);
    expect(manifest.usingComponents[0]).toMatchObject({
      tag: "global-bar",
      specifier: "/components/global-bar",
      file: "app.json",
    });

    const source = await readFile(path.join(FIXTURE_DIR, "app.json"), "utf8");
    const lines = source.split("\n");
    expect(lines[manifest.subpackages[0].line - 1]).toContain('"root": "packageA"');
    expect(lines[manifest.usingComponents[0].line - 1]).toContain('"global-bar"');
  });

  it("accepts the camelCase subPackages alias", async () => {
    await withProject(
      {
        "app.json": JSON.stringify(
          {
            pages: ["pages/index/index"],
            subPackages: [{ root: "pkgB", pages: ["pages/x/index"] }],
          },
          null,
          2,
        ),
        "pages/index/index.wxml": "<view></view>",
        "pkgB/pages/x/index.wxml": "<view></view>",
      },
      async (dir) => {
        const manifest = await readAppManifest(dir);
        expect(manifest.subpackages).toEqual([
          expect.objectContaining({
            root: "pkgB",
            pages: ["pkgB/pages/x/index"],
            independent: false,
          }),
        ]);

        const graph = await buildGraph(dir);
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            rel: "in_subpackage",
            from: "pkgB/pages/x/index",
            to: "subpackage:pkgB",
            root: "pkgB",
          }),
        );
      },
    );
  });
});

describe("usingComponents resolution", () => {
  it("resolves root-absolute, relative and npm specifiers", () => {
    expect(
      resolveComponentSpecifier(FIXTURE_DIR, "pages/cart/index.json", "/components/global-bar"),
    ).toMatchObject({ ok: true, target: { id: "components/global-bar" } });

    expect(
      resolveComponentSpecifier(
        FIXTURE_DIR,
        "pages/cart/index.json",
        "../../components/price-card",
      ),
    ).toMatchObject({ ok: true, target: { id: "components/price-card" } });

    expect(
      resolveComponentSpecifier(FIXTURE_DIR, "pages/cart/index.json", "mp-html"),
    ).toMatchObject({
      ok: true,
      target: { id: "miniprogram_npm/mp-html/index", via: "miniprogram_npm" },
    });

    expect(
      resolveComponentSpecifier(
        FIXTURE_DIR,
        "components/price-card.json",
        "@echarts/mini-program/ec-canvas",
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("buildGraph", () => {
  it("emits pages, components, elements and the m1 edges", async () => {
    const graph = await buildGraph(FIXTURE_DIR);

    const pages = graph.nodes
      .filter((node): node is UnitNode => node.kind === "page")
      .map((node) => node.id);
    expect(pages).toEqual(
      expect.arrayContaining([
        "packageA/pages/list/index",
        "pages/cart/index",
        "pages/order/detail",
      ]),
    );
    expect(pages).toHaveLength(3);

    const components = graph.nodes
      .filter((node): node is UnitNode => node.kind === "component")
      .map((node) => node.id);
    expect(components).toEqual(
      expect.arrayContaining([
        "components/global-bar",
        "components/price-card",
        "miniprogram_npm/@vant/weapp/button/index",
        "miniprogram_npm/mp-html/index",
      ]),
    );
    expect(components).toHaveLength(4);

    const includes = graph.edges
      .filter((edge) => edge.rel === "includes")
      .map((edge) => `${edge.from} -> ${edge.to} (${edge.tag})`);
    expect(includes).toEqual(
      expect.arrayContaining([
        "pages/cart/index -> components/price-card (price-card)",
        "pages/cart/index -> miniprogram_npm/mp-html/index (mp-html)",
        "pages/cart/index -> components/global-bar (global-bar)",
        "pages/order/detail -> components/price-card (price-card)",
        "pages/order/detail -> components/global-bar (global-bar)",
        "components/price-card -> miniprogram_npm/@vant/weapp/button/index (van-button)",
      ]),
    );
    expect(includes.some((edge) => edge.includes("echarts"))).toBe(false);

    expect(graph.edges).toContainEqual({
      rel: "in_subpackage",
      from: "packageA/pages/list/index",
      to: "subpackage:packageA",
      root: "packageA",
      file: "app.json",
      line: 14,
    });

    expect(graph.warnings).toHaveLength(1);
    expect(graph.warnings[0]).toMatchObject({
      code: "unresolved_component",
      file: "components/price-card.json",
      line: 5,
    });
    expect(graph.warnings[0].message).toContain("@echarts/mini-program/ec-canvas");

    expect(graph.subpackages).toEqual([
      { root: "packageA", independent: true, pages: ["packageA/pages/list/index"] },
    ]);
    expect(graph.stats).toMatchObject({
      subpackages: 1,
      pages: 3,
      components: 4,
    });
    expect(graph.stats.elements).toBeGreaterThan(0);
    expect(graph.stats.handles).toBeGreaterThan(0);

    for (const edge of graph.edges) {
      expect(edge.line).toBeGreaterThan(0);
      expect(edge.file).toMatch(/\.(json|wxml)$/);
    }
  });

  it("falls back to node_modules for npm specifiers", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "pages/index/index.json": JSON.stringify(
          { usingComponents: { "mp-html": "mp-html" } },
          null,
          2,
        ),
        "pages/index/index.wxml": '<view><mp-html content="{{html}}"></mp-html></view>',
        "node_modules/mp-html/index.json": JSON.stringify({ component: true }, null, 2),
        "node_modules/mp-html/index.wxml": "<view>{{content}}</view>",
      },
      async (dir) => {
        const graph = await buildGraph(dir);
        expect(graph.warnings).toEqual([]);
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            rel: "includes",
            from: "pages/index/index",
            to: "node_modules/mp-html/index",
            tag: "mp-html",
          }),
        );
      },
    );
  });

  it("writes one JSON file whose edges keep their provenance", async () => {
    await withProject(
      {
        "app.json": JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "pages/index/index.wxml": '<view bindtap="onTap">{{title}}</view>',
      },
      async (dir) => {
        const outFile = path.join(dir, ".wxgraph", "graph.json");
        const graph = await writeGraph(dir, outFile);
        const written = JSON.parse(await readFile(outFile, "utf8")) as {
          schemaVersion: number;
          edges: Array<{ file: string; line: number }>;
          stats: { edges: number };
        };

        expect(written.schemaVersion).toBe(1);
        expect(written.stats.edges).toBe(graph.edges.length);
        expect(written.edges).toHaveLength(graph.edges.length);
        for (const edge of written.edges) {
          expect(edge.file).toBe("pages/index/index.wxml");
          expect(edge.line).toBeGreaterThan(0);
        }
      },
    );
  });
});
