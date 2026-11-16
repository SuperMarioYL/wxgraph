#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadGraph, writeGraph } from "../graph/build";
import { computeImpact, computeImpactUp, explain, formatImpact, formatImpactUp } from "../query/impact";
import { formatSearch, searchGraph } from "../query/search";

const STALE_HINT = "run wxgraph build";
const SEARCH_LIMIT = 50;

function text(value: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: value }] };
}

function failure(value: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { ...text(value), isError: true };
}

/**
 * MCP server over stdio.
 *
 * Every answering tool first checks the graph stamp: a stale graph would make
 * the impact answer confidently wrong, so the only reply is the one command
 * that fixes it.
 */
export function createWxgraphServer(projectDir: string): McpServer {
  const server = new McpServer(
    { name: "wxgraph", version: "0.1.0" },
    {
      instructions:
        "Semantic graph of a WeChat mini-program. Ask wxgraph_impact before reading " +
        "WXML/JS files to trace a change; the graph carries setData -> render edges " +
        "with file:line provenance. wxgraph_search finds a node id when you only " +
        "know a name.",
    },
  );

  server.registerTool(
    "wxgraph_impact",
    {
      title: "What re-renders if this changes",
      description:
        "Blast radius of a page, component or element: which hosts include it, " +
        "which data path feeds each property, and which setData calls re-render which " +
        "elements. Non-literal setData sites and hops that failed to resolve are " +
        "reported instead of guessed. Set up: true to walk callers instead of callees.",
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe('Unit id ("components/price-card"), file path, or element id'),
        json: z.boolean().optional().describe("Return the structured result instead of a tree"),
        up: z
          .boolean()
          .optional()
          .describe("Walk the hosts that include this target, transitively, instead of its re-renders"),
      },
    },
    async ({ target, json, up }) => {
      const loaded = await loadGraph(projectDir);
      if (loaded.status !== "ok") return failure(STALE_HINT);
      try {
        if (up === true) {
          const result = computeImpactUp(loaded.graph, target);
          return text(
            json === true ? `${JSON.stringify(result, null, 2)}\n` : formatImpactUp(result),
          );
        }
        const result = computeImpact(loaded.graph, target);
        return text(json === true ? `${JSON.stringify(result, null, 2)}\n` : formatImpact(result));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "wxgraph_explain",
    {
      title: "Explain one edge",
      description:
        "Print every hop behind a setData call site or an element, including the hops " +
        "that failed to resolve and why.",
      inputSchema: {
        edge: z
          .string()
          .min(1)
          .describe('setData node id, "file:line" call site, or element id'),
      },
    },
    async ({ edge }) => {
      const loaded = await loadGraph(projectDir);
      if (loaded.status !== "ok") return failure(STALE_HINT);
      try {
        return text(explain(loaded.graph, edge));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "wxgraph_search",
    {
      title: "Find a node",
      description:
        "Case-insensitive search over page/component ids, element ids, handler names, " +
        "data paths and setData keys. Use it to find the exact target for " +
        "wxgraph_impact or wxgraph_explain.",
      inputSchema: {
        query: z.string().min(1).describe('Text to find, e.g. "price-card" or "unitPrice"'),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum hits (default 50)"),
      },
    },
    async ({ query, limit }) => {
      const loaded = await loadGraph(projectDir);
      if (loaded.status !== "ok") return failure(STALE_HINT);
      const max = limit ?? SEARCH_LIMIT;
      try {
        return text(formatSearch(searchGraph(loaded.graph, query, max), max));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "wxgraph_stats",
    {
      title: "Graph counts and warnings",
      description:
        "Node/edge counts, unreadable `.js` files, `.ts` files that are not analysed, " +
        "unresolved components and handler attributes with no matching method.",
      inputSchema: {},
    },
    async () => {
      const loaded = await loadGraph(projectDir);
      if (loaded.status !== "ok") return failure(STALE_HINT);
      const { graph } = loaded;
      const lines = [
        `graph     ${loaded.graphFile}`,
        `stamp     ${graph.stamp?.digest ?? "?"}  ${graph.stamp?.files ?? 0} source files`,
        "",
        `${graph.stats.subpackages} subpackages · ${graph.stats.pages} pages · ` +
          `${graph.stats.components} components · ${graph.stats.elements} wxml nodes · ` +
          `${graph.stats.nodes} nodes · ${graph.stats.edges} edges`,
        `${graph.stats.binds} binds · ${graph.stats.handles} handles · ` +
          `${graph.stats.calls_setdata} calls_setdata · ${graph.stats.rerenders} rerenders`,
        `${graph.stats.handlers} handlers · ${graph.stats.set_data} setData sites · ` +
          `${graph.stats.cloud_fns} cloud functions`,
        `scripts   ${graph.stats.js_files} .js files seen · ${graph.stats.js_parsed} parsed · ` +
          `${graph.stats.js_unresolved} unresolved · ${graph.stats.ts_files} .ts files not analysed`,
      ];
      if (graph.warnings.length > 0) {
        lines.push("", `${graph.warnings.length} warning(s):`);
        for (const warning of graph.warnings) {
          const where = warning.file === undefined ? "" : `  ${warning.file}${warning.line ? `:${warning.line}` : ""}`;
          lines.push(`  [${warning.code}]${where}  ${warning.message}`);
        }
      }
      return text(`${lines.join("\n")}\n`);
    },
  );

  server.registerTool(
    "wxgraph_build",
    {
      title: "Rebuild the graph",
      description:
        "Re-index the mini-program and write .wxgraph/graph.json plus a source stamp. " +
        "Run this after editing WXML, JSON or JS.",
      inputSchema: {},
    },
    async () => {
      try {
        const graph = await writeGraph(projectDir);
        return text(
          `${graph.stats.subpackages} subpackages · ${graph.stats.pages} pages · ` +
            `${graph.stats.components} components · ${graph.stats.elements} wxml nodes · ` +
            `${graph.stats.edges} edges\nwrote ${path.join(projectDir, ".wxgraph", "graph.json")}\n`,
        );
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
  );

  return server;
}

function projectFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--project");
  if (flag >= 0 && argv[flag + 1] !== undefined) return path.resolve(argv[flag + 1]);
  return path.resolve(process.env.WXGRAPH_PROJECT ?? process.cwd());
}

export async function startMcpServer(projectDir = projectFromArgv(process.argv.slice(2))): Promise<void> {
  const server = createWxgraphServer(projectDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Compare real paths so an npm bin symlink still starts the server. */
function invokedAsMain(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  startMcpServer().catch((error: unknown) => {
    process.stderr.write(`wxgraph mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
