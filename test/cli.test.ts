import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { main } from "../src/cli";
import type { Graph } from "../src/graph/schema";

const DEMO_DIR = path.resolve("examples/demo");
const GRAPH_FILE = path.join(DEMO_DIR, ".wxgraph", "graph.json");
const ROOT_DIR = process.cwd();

function capture(): {
  io: { out(text: string): void; err(text: string): void };
  out(): string;
  err(): string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const channel = capture();
  const code = await main(args, channel.io, process.cwd());
  return { code, out: channel.out(), err: channel.err() };
}

async function readDemoGraph(): Promise<Graph> {
  return JSON.parse(await readFile(GRAPH_FILE, "utf8")) as Graph;
}

afterAll(async () => {
  await rm(path.join(DEMO_DIR, ".wxgraph"), { recursive: true, force: true });
  // `build examples/demo` from the repository root records the project there.
  await rm(path.join(ROOT_DIR, ".wxgraph"), { recursive: true, force: true });
});

describe("wxgraph CLI", () => {
  it("builds the shipped demo and prints the graph counts", async () => {
    const result = await run(["build", "examples/demo"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "1 subpackage · 3 pages · 1 component · 19 wxml nodes · 57 edges",
    );
    expect(result.out).toContain("wrote examples/demo/.wxgraph/graph.json");

    const graph = await readDemoGraph();
    expect(graph.stats).toMatchObject({
      subpackages: 1,
      pages: 3,
      components: 1,
      elements: 19,
      edges: 57,
      cloud_fns: 1,
    });
    expect(graph.warnings).toEqual([]);
    expect(graph.subpackages[0]).toMatchObject({ root: "packageOrder", independent: false });
  });

  it("answers impact for the demo component with both property hops", async () => {
    const result = await run(["impact", "components/price-card", "-C", "examples/demo"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("components/price-card  (component)  included by 2 hosts");
    expect(result.out).toContain('price="{{item.unitPrice}}"');
    expect(result.out).toContain('price="{{order.total}}"');
    expect(result.out).toContain("setData({items, editing}) in onEdit");
    expect(result.out).toContain("[via prop:price]");
    expect(result.out).toContain("[via prop:editing]");
    expect(result.out).toContain("1 unresolved_setdata site(s):");
    expect(result.out).toContain("pages/cart/index.js");
  });

  it("returns the structured impact result with --json", async () => {
    const result = await run([
      "impact",
      "components/price-card",
      "--json",
      "-C",
      "examples/demo",
    ]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as {
      hosts: Array<{ host: string; passes: Array<{ attr: string; path: string }> }>;
      rerenders: Array<{ via: string; handler: { name: string } | null; elementTag: string }>;
    };
    expect(parsed.hosts.map((host) => host.host)).toEqual([
      "pages/cart/index",
      "pages/order/detail",
    ]);
    expect(parsed.hosts[0].passes).toContainEqual(
      expect.objectContaining({ attr: "price", path: "items[].unitPrice" }),
    );
    expect(parsed.rerenders).toContainEqual(
      expect.objectContaining({ via: "prop:price", elementTag: "text" }),
    );
    expect(parsed.rerenders).toContainEqual(
      expect.objectContaining({ via: "prop:editing", elementTag: "view" }),
    );
    expect(parsed.rerenders).toContainEqual(
      expect.objectContaining({
        via: "prop:price",
        handler: expect.objectContaining({ name: "onEdit" }),
      }),
    );
  });

  it("answers the documented commands from the repository root after building a subdirectory", async () => {
    const build = await run(["build", "examples/demo"]);
    expect(build.code).toBe(0);
    expect(build.out).toContain("wrote examples/demo/.wxgraph/graph.json");

    // No -C and no cd: the build recorded the project for this directory.
    const impact = await run(["impact", "components/price-card"]);
    expect(impact.code).toBe(0);
    expect(impact.out).toContain("included by 2 hosts");
    expect(impact.out).toContain("[via prop:price]");

    const stats = await run(["stats"]);
    expect(stats.code).toBe(0);
    expect(stats.out).toContain("graph     examples/demo/.wxgraph/graph.json");
    expect(stats.out).toContain("4 .js files seen · 4 parsed · 0 unresolved");
  });

  it("walks the hosts of a target with --up", async () => {
    const result = await run(["impact", "components/price-card", "--up"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("reached from 2 unit(s): 2 direct host(s), 1 level(s) up");
    expect(result.out).toContain("via <price-card>  pages/cart/index.wxml:5");
    expect(result.out).toContain("via <price-card>  pages/order/detail.wxml:4");
  });

  it("finds nodes by name with search", async () => {
    const result = await run(["search", "unitPrice"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("1 match for \"unitPrice\"");
    expect(result.out).toContain("pages/cart/index:items[].unitPrice");

    const machine = await run(["search", "price-card", "--json"]);
    expect(machine.code).toBe(0);
    const parsed = JSON.parse(machine.out) as { total: number; hits: unknown[] };
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.hits.length).toBeGreaterThan(0);
  });

  it("records the project with init and prints the agent setup", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wxgraph-cli-init-"));
    try {
      await writeFile(
        path.join(dir, "app.json"),
        JSON.stringify({ pages: ["pages/index/index"] }, null, 2),
        "utf8",
      );
      const channel = capture();
      const code = await main(["init"], channel.io, dir);

      expect(code).toBe(0);
      expect(channel.out()).toContain("project   .");
      expect(channel.out()).toContain("mcpServers");
      expect(channel.out()).toContain(
        "cp -r <wxgraph-checkout>/skills/wxgraph .claude/skills/",
      );
      const config = JSON.parse(
        await readFile(path.join(dir, ".wxgraph", "config.json"), "utf8"),
      ) as { project: string };
      expect(config).toEqual({ project: "." });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("explains the hops of the demo's onEdit call site", async () => {    const result = await run(["explain", "pages/cart/index.js:20", "-C", "examples/demo"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("handler  onEdit");
    expect(result.out).toContain("keys     items, editing");
    expect(result.out).toContain("resolved [prop:price]");
    expect(result.out).toContain("resolved [prop:editing]");
  });

  it("prints stats for the built graph", async () => {
    const result = await run(["stats", "-C", "examples/demo"]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("1 subpackage · 3 pages · 1 component");
    expect(result.out).toContain("1 cloud function");
    expect(result.out).toContain("14 source files");
  });

  it("fails closed with one line when the graph is missing", async () => {
    await rm(path.join(DEMO_DIR, ".wxgraph"), { recursive: true, force: true });

    for (const args of [
      ["impact", "components/price-card", "-C", "examples/demo"],
      ["explain", "pages/cart/index.js:20", "-C", "examples/demo"],
      ["stats", "-C", "examples/demo"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.out).toBe("");
      expect(result.err.trim().split("\n")).toHaveLength(1);
      expect(result.err).toContain("run wxgraph build");
    }
  });

  it("rejects unknown commands and unknown targets with a non-zero exit", async () => {
    const unknownCommand = await run(["reindex"]);
    expect(unknownCommand.code).toBe(1);
    expect(unknownCommand.err).toContain("unknown command");

    await run(["build", "examples/demo"]);
    const unknownTarget = await run(["impact", "components/nope", "-C", "examples/demo"]);
    expect(unknownTarget.code).toBe(1);
    expect(unknownTarget.err).toBe(
      'wxgraph: no page, component or element matches "components/nope"\n',
    );
  });
});

describe("demo mini-program", () => {
  it("exercises both handler spellings, a cloud call and a non-literal setData", async () => {
    const built = await run(["build", "examples/demo"]);
    expect(built.code).toBe(0);

    const graph = await readDemoGraph();
    const handles = graph.edges.filter((edge) => edge.rel === "handles");
    const modifiers = new Set(handles.map((edge) => edge.modifier));

    expect(modifiers).toEqual(new Set(["bind", "catch"]));
    expect(graph.nodes).toContainEqual({ kind: "cloud_fn", name: "checkout" });

    const calls = graph.nodes.filter((node) => node.kind === "set_data");
    expect(calls.some((call) => call.keys === null)).toBe(true);
    expect(calls.some((call) => call.keys?.includes("order.no"))).toBe(true);

    const component = graph.nodes.find(
      (node) => node.kind === "component" && node.id === "components/price-card",
    );
    expect(component).toMatchObject({ properties: ["editing", "price"] });
  });
});
