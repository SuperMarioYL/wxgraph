#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import packageJson from "../package.json";
import { loadGraph, writeGraph } from "./graph/build";
import type { Graph } from "./graph/schema";
import { computeImpact, explain, formatImpact } from "./query/impact";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const STALE_HINT = "run wxgraph build";
const GRAPH_FILE = ".wxgraph/graph.json";

/** An expected failure: printed as one line, never as a stack trace. */
class CliError extends Error {}

function count(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

function statsLine(graph: Graph, elapsedMs?: number): string {
  const stats = graph.stats;
  const timing = elapsedMs === undefined ? "" : ` · ${elapsedMs}ms`;
  return (
    `${count(stats.subpackages, "subpackage")} · ${count(stats.pages, "page")} · ` +
    `${count(stats.components, "component")} · ${count(stats.elements, "wxml node")} · ` +
    `${count(stats.edges, "edge")}${timing}`
  );
}

function statsReport(graph: Graph): string {
  const stats = graph.stats;
  const stamp = graph.stamp;
  const lines = [
    `graph     ${GRAPH_FILE}`,
    `stamp     ${stamp?.digest ?? "?"}  ${stamp?.files ?? 0} source files`,
    "",
    statsLine(graph),
    `${stats.binds} binds · ${stats.handles} handles · ` +
      `${stats.calls_setdata} calls_setdata · ${stats.rerenders} rerenders`,
    `${count(stats.handlers, "handler")} · ${count(stats.set_data, "setData site")} · ` +
      `${count(stats.cloud_fns, "cloud function")}`,
  ];
  if (graph.warnings.length > 0) {
    lines.push("", `${graph.warnings.length} warning(s):`);
    for (const warning of graph.warnings) {
      const where =
        warning.file === undefined
          ? ""
          : `  ${warning.file}${warning.line === undefined ? "" : `:${warning.line}`}`;
      lines.push(`  [${warning.code}]${where}  ${warning.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function buildCommand(dir: string, io: CliIo, cwd: string): Promise<void> {
  const projectDir = path.resolve(cwd, dir);
  if (!existsSync(path.join(projectDir, "app.json"))) {
    throw new CliError(`no app.json in ${projectDir} — is this a mini-program root?`);
  }
  const started = Date.now();
  const graph = await writeGraph(projectDir);
  const elapsed = Date.now() - started;

  io.out(`${statsLine(graph, elapsed)}\n`);
  if (graph.warnings.length > 0) {
    io.out(`${graph.warnings.length} warning(s) — run wxgraph stats for details\n`);
  }
  io.out(`wrote ${GRAPH_FILE}\n`);
}

async function loadForQuery(projectDir: string, io: CliIo): Promise<Graph | null> {
  const loaded = await loadGraph(projectDir);
  if (loaded.status === "ok") return loaded.graph;
  if (loaded.status === "missing") {
    io.err(`wxgraph: no graph at ${path.join(projectDir, GRAPH_FILE)} — ${STALE_HINT}\n`);
  } else {
    io.err(`wxgraph: graph is stale (${loaded.reason}) — ${STALE_HINT}\n`);
  }
  return null;
}

function projectOption(command: Command): Command {
  return command.option("-C, --project <dir>", "mini-program directory (default: cwd)");
}

function projectDirOf(options: { project?: string }, cwd: string): string {
  return path.resolve(cwd, options.project ?? ".");
}

export async function main(
  argv: string[],
  io: CliIo = defaultIo,
  cwd = process.cwd(),
): Promise<number> {
  let exitCode = 0;

  const program = new Command();
  program
    .name("wxgraph")
    .description("Semantic code graph for WeChat mini-programs")
    .version(packageJson.version, "-v, --version", "print the version")
    .configureOutput({
      writeOut: (text) => io.out(text),
      writeErr: (text) => io.err(text),
    })
    .exitOverride()
    .showHelpAfterError();

  program
    .command("build")
    .argument("[dir]", "mini-program directory", ".")
    .description("index app.json, *.json, *.wxml and *.js into .wxgraph/graph.json")
    .action(async (dir: string) => {
      await buildCommand(dir, io, cwd);
    });

  projectOption(
    program
      .command("impact")
      .argument("<target>", "page, component or element id")
      .description("show what re-renders when a page or component changes")
      .option("--json", "print the structured result"),
  ).action(async (target: string, options: { project?: string; json?: boolean }) => {
    const graph = await loadForQuery(projectDirOf(options, cwd), io);
    if (graph === null) {
      exitCode = 1;
      return;
    }
    const result = computeImpact(graph, target);
    io.out(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatImpact(result));
  });

  projectOption(
    program
      .command("explain")
      .argument("<edge>", 'setData node id, "file:line" call site, or element id')
      .description("print every hop behind one edge, including the hops that failed"),
  ).action(async (reference: string, options: { project?: string }) => {
    const graph = await loadForQuery(projectDirOf(options, cwd), io);
    if (graph === null) {
      exitCode = 1;
      return;
    }
    io.out(explain(graph, reference));
  });

  projectOption(
    program.command("stats").description("print graph counts and what the parser could not read"),
  ).action(async (options: { project?: string }) => {
    const graph = await loadForQuery(projectDirOf(options, cwd), io);
    if (graph === null) {
      exitCode = 1;
      return;
    }
    io.out(statsReport(graph));
  });

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof CliError) {
      io.err(`wxgraph: ${error.message}\n`);
      return 1;
    }
    io.err(`wxgraph: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  return exitCode;
}

/** Compare real paths so an npm bin symlink still runs the CLI. */
function invokedAsMain(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
