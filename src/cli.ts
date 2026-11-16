#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import packageJson from "../package.json";
import { loadGraph, writeGraph } from "./graph/build";
import type { Graph } from "./graph/schema";
import { toPosix } from "./parse/manifest";
import {
  computeImpact,
  computeImpactUp,
  explain,
  formatImpact,
  formatImpactUp,
} from "./query/impact";
import { formatSearch, searchGraph } from "./query/search";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const GRAPH_FILE = path.join(".wxgraph", "graph.json");
/** Records which project a working directory queries, written by init/build. */
const CONFIG_FILE = path.join(".wxgraph", "config.json");
const SEARCH_LIMIT = 50;

/** An expected failure: printed as one line, never as a stack trace. */
class CliError extends Error {}

function count(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

function graphFileOf(projectDir: string): string {
  return path.join(projectDir, GRAPH_FILE);
}

/** Path relative to the invocation directory, always with forward slashes. */
function displayPath(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute);
  if (relative === "") return ".";
  // A path outside the working tree reads better absolute than as ../../..
  return relative.startsWith("..") ? toPosix(absolute) : toPosix(relative);
}

function buildHint(cwd: string, projectDir: string): string {
  const relative = displayPath(cwd, projectDir);
  return relative === "." ? "run wxgraph build" : `run wxgraph build ${relative}`;
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

function scriptLine(graph: Graph): string {
  const stats = graph.stats;
  return (
    `scripts   ${count(stats.js_files, ".js file")} seen · ${stats.js_parsed} parsed · ` +
    `${stats.js_unresolved} unresolved · ${count(stats.ts_files, ".ts file")} not analysed`
  );
}

function statsReport(graph: Graph, graphPath: string): string {
  const stats = graph.stats;
  const stamp = graph.stamp;
  const lines = [
    `graph     ${graphPath}`,
    `stamp     ${stamp?.digest ?? "?"}  ${stamp?.files ?? 0} source files`,
    "",
    statsLine(graph),
    `${stats.binds} binds · ${stats.handles} handles · ` +
      `${stats.calls_setdata} calls_setdata · ${stats.rerenders} rerenders`,
    `${count(stats.handlers, "handler")} · ${count(stats.set_data, "setData site")} · ` +
      `${count(stats.cloud_fns, "cloud function")}`,
    scriptLine(graph),
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

interface ProjectConfig {
  project: string;
}

/**
 * The project a working directory queries. A query with no `-C` uses the
 * graph in the cwd; otherwise it follows the project that `init` or the last
 * `build` recorded in `.wxgraph/config.json`.
 */
async function readConfigProject(cwd: string): Promise<string | null> {
  const configFile = path.join(cwd, CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(configFile, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>;
    if (typeof parsed.project === "string" && parsed.project.trim() !== "") {
      return path.resolve(cwd, parsed.project);
    }
  } catch {
    // Reported below: a present but unusable config is not "no config".
  }
  throw new CliError(
    `${displayPath(cwd, configFile)} is not a usable project config — run wxgraph init`,
  );
}

async function writeConfigProject(cwd: string, projectDir: string): Promise<string> {
  const configFile = path.join(cwd, CONFIG_FILE);
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(
    configFile,
    `${JSON.stringify({ project: displayPath(cwd, projectDir) }, null, 2)}\n`,
    "utf8",
  );
  return configFile;
}

async function resolveProjectDir(
  options: { project?: string },
  cwd: string,
): Promise<string> {
  if (options.project !== undefined) return path.resolve(cwd, options.project);
  const here = path.resolve(cwd);
  if (existsSync(graphFileOf(here))) return here;
  const recorded = await readConfigProject(here);
  if (recorded !== null && existsSync(recorded)) return recorded;
  return here;
}

async function buildCommand(dir: string, io: CliIo, cwd: string): Promise<void> {
  const projectDir = path.resolve(cwd, dir);
  if (!existsSync(path.join(projectDir, "app.json"))) {
    throw new CliError(`no app.json in ${projectDir} — is this a mini-program root?`);
  }
  const started = Date.now();
  const graph = await writeGraph(projectDir);
  const elapsed = Date.now() - started;

  // A build from a parent directory makes that directory query this project.
  if (projectDir !== path.resolve(cwd)) {
    await writeConfigProject(cwd, projectDir);
  }

  io.out(`${statsLine(graph, elapsed)}\n`);
  if (graph.warnings.length > 0) {
    io.out(`${graph.warnings.length} warning(s) — run wxgraph stats for details\n`);
  }
  io.out(`wrote ${displayPath(cwd, graphFileOf(projectDir))}\n`);
}

function findAppRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "app.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function initCommand(
  dir: string | undefined,
  io: CliIo,
  cwd: string,
): Promise<void> {
  const start = path.resolve(cwd, dir ?? ".");
  const projectDir = findAppRoot(start);
  if (projectDir === null) {
    throw new CliError(
      `no app.json at or above ${start} — run wxgraph init inside a mini-program, ` +
        `or pass its directory: wxgraph init <dir>`,
    );
  }

  const configFile = await writeConfigProject(cwd, projectDir);
  const graphFile = graphFileOf(projectDir);
  const graphLine = existsSync(graphFile)
    ? displayPath(cwd, graphFile)
    : `not built yet — ${buildHint(cwd, projectDir)}`;
  const snippet = JSON.stringify({
    mcpServers: {
      wxgraph: { command: "wxgraph-mcp", args: ["--project", projectDir] },
    },
  });
  const lines = [
    `project   ${displayPath(cwd, projectDir)}`,
    `config    ${displayPath(cwd, configFile)}`,
    `graph     ${graphLine}`,
    "",
    "MCP (stdio; any client — Gemini CLI, Cursor, or your own agent loop):",
    `  ${snippet}`,
    "",
    "Skill:",
    "  cp -r <wxgraph-checkout>/skills/wxgraph .claude/skills/",
  ];
  io.out(`${lines.join("\n")}\n`);
}

async function loadForQuery(
  projectDir: string,
  io: CliIo,
  cwd: string,
): Promise<Graph | null> {
  const loaded = await loadGraph(projectDir);
  if (loaded.status === "ok") return loaded.graph;
  const graphPath = displayPath(cwd, graphFileOf(projectDir));
  const hint = buildHint(cwd, projectDir);
  if (loaded.status === "missing") {
    io.err(`wxgraph: no graph at ${graphPath} — ${hint}\n`);
  } else {
    io.err(`wxgraph: graph is stale (${loaded.reason}) — ${hint}\n`);
  }
  return null;
}

function projectOption(command: Command): Command {
  return command.option("-C, --project <dir>", "mini-program directory (default: cwd)");
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
    .command("init")
    .argument("[dir]", "mini-program directory (default: cwd, then its parents)")
    .description("find app.json, write .wxgraph/config.json and print the agent setup")
    .action(async (dir: string | undefined) => {
      await initCommand(dir, io, cwd);
    });

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
      .option("--json", "print the structured result")
      .option("--up", "walk the hosts that include this target instead of its re-renders"),
  ).action(
    async (target: string, options: { project?: string; json?: boolean; up?: boolean }) => {
      const projectDir = await resolveProjectDir(options, cwd);
      const graph = await loadForQuery(projectDir, io, cwd);
      if (graph === null) {
        exitCode = 1;
        return;
      }
      if (options.up === true) {
        const up = computeImpactUp(graph, target);
        io.out(options.json === true ? `${JSON.stringify(up, null, 2)}\n` : formatImpactUp(up));
        return;
      }
      const result = computeImpact(graph, target);
      io.out(
        options.json === true ? `${JSON.stringify(result, null, 2)}\n` : formatImpact(result),
      );
    },
  );

  projectOption(
    program
      .command("explain")
      .argument("<edge>", 'setData node id, "file:line" call site, or element id')
      .description("print every hop behind one edge, including the hops that failed"),
  ).action(async (reference: string, options: { project?: string }) => {
    const projectDir = await resolveProjectDir(options, cwd);
    const graph = await loadForQuery(projectDir, io, cwd);
    if (graph === null) {
      exitCode = 1;
      return;
    }
    io.out(explain(graph, reference));
  });

  projectOption(
    program
      .command("search")
      .argument("<query>", "text to find in ids, paths, tags and setData keys")
      .description("find the node to ask impact or explain about")
      .option("--json", "print the structured result"),
  ).action(async (query: string, options: { project?: string; json?: boolean }) => {
    const projectDir = await resolveProjectDir(options, cwd);
    const graph = await loadForQuery(projectDir, io, cwd);
    if (graph === null) {
      exitCode = 1;
      return;
    }
    const result = searchGraph(graph, query, SEARCH_LIMIT);
    io.out(
      options.json === true
        ? `${JSON.stringify(result, null, 2)}\n`
        : formatSearch(result, SEARCH_LIMIT),
    );
  });

  projectOption(
    program.command("stats").description("print graph counts and what the parser could not read"),
  ).action(async (options: { project?: string }) => {
    const projectDir = await resolveProjectDir(options, cwd);
    const graph = await loadForQuery(projectDir, io, cwd);
    if (graph === null) {
      exitCode = 1;
      return;
    }
    io.out(statsReport(graph, displayPath(cwd, graphFileOf(projectDir))));
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
