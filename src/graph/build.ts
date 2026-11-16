import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import fg from "fast-glob";

import {
  parseFileManifest,
  readAppManifest,
  readFileManifest,
  resolveComponentSpecifier,
  toPosix,
  unitIdForManifest,
  type ComponentDeclaration,
  type FileManifest,
  type ResolvedSpecifier,
} from "../parse/manifest";
import { parseScript } from "../parse/script";
import { parseWxml, type ParsedWxml } from "../parse/wxml";
import { resolveGraph } from "./resolve";
import {
  subpackageId,
  type CloudFnNode,
  type DataFieldNode,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphStamp,
  type GraphWarning,
  type UnitNode,
} from "./schema";

const IGNORED_GLOBS = [
  "**/node_modules/**",
  "**/miniprogram_npm/**",
  "**/.git/**",
  "**/.wxgraph/**",
  "**/dist/**",
];

const STAMP_GLOBS = "**/*.{json,wxml,js,ts}";

interface UnitState {
  unit: UnitNode;
  /** Resolved declarations keyed by tag. */
  resolved: Map<string, ResolvedSpecifier>;
}

async function readOptionalFile(projectDir: string, file: string): Promise<string | null> {
  try {
    return await readFile(path.join(projectDir, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function mergeDeclarations(
  appDeclarations: ComponentDeclaration[],
  fileDeclarations: ComponentDeclaration[],
): Map<string, ComponentDeclaration> {
  const merged = new Map<string, ComponentDeclaration>();
  for (const declaration of appDeclarations) merged.set(declaration.tag, declaration);
  for (const declaration of fileDeclarations) merged.set(declaration.tag, declaration);
  return merged;
}

function warningKey(warning: GraphWarning): string {
  return [warning.code, warning.file ?? "", warning.line ?? "", warning.message].join("\u0000");
}

function edgeKey(edge: GraphEdge): string {
  switch (edge.rel) {
    case "contains":
      return `contains\u0000${edge.from}\u0000${edge.to}`;
    case "includes":
      return `includes\u0000${edge.from}\u0000${edge.to}`;
    case "in_subpackage":
      return `in_subpackage\u0000${edge.from}\u0000${edge.to}`;
    case "invokes":
      return `invokes\u0000${edge.from}\u0000${edge.to}`;
    case "binds":
      return `binds\u0000${edge.element}\u0000${edge.attr}\u0000${edge.field}`;
    case "handles":
      return `handles\u0000${edge.element}\u0000${edge.handler}\u0000${edge.event}\u0000${edge.modifier}`;
    case "calls_setdata":
      return `calls_setdata\u0000${edge.handler}\u0000${edge.call}`;
    case "rerenders":
      return `rerenders\u0000${edge.call}\u0000${edge.element}\u0000${edge.via}`;
  }
}

const EDGE_RANK: Record<GraphEdge["rel"], number> = {
  contains: 0,
  includes: 1,
  in_subpackage: 2,
  invokes: 3,
  binds: 4,
  handles: 5,
  calls_setdata: 6,
  rerenders: 7,
};

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  const rank = EDGE_RANK[left.rel] - EDGE_RANK[right.rel];
  if (rank !== 0) return rank;
  if (left.file !== right.file) return left.file.localeCompare(right.file);
  if (left.line !== right.line) return left.line - right.line;
  return edgeKey(left).localeCompare(edgeKey(right));
}

const NODE_RANK: Record<GraphNode["kind"], number> = {
  page: 0,
  component: 1,
  element: 2,
  data_field: 3,
  handler: 4,
  set_data: 5,
  cloud_fn: 6,
};

function nodeId(node: GraphNode): string {
  switch (node.kind) {
    case "data_field":
      return `${node.owner}:${node.path}`;
    case "handler":
    case "set_data":
      return node.id;
    case "cloud_fn":
      return node.name;
    default:
      return node.id;
  }
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  const rank = NODE_RANK[left.kind] - NODE_RANK[right.kind];
  if (rank !== 0) return rank;
  if (left.kind === "element" && right.kind === "element") {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    if (left.line !== right.line) return left.line - right.line;
  }
  return nodeId(left).localeCompare(nodeId(right));
}

function sortWarnings(warnings: GraphWarning[]): GraphWarning[] {
  return warnings.sort((left, right) => {
    const file = (left.file ?? "").localeCompare(right.file ?? "");
    if (file !== 0) return file;
    return (left.line ?? 0) - (right.line ?? 0);
  });
}

function countKind(nodes: GraphNode[], kind: GraphNode["kind"]): number {
  return nodes.filter((node) => node.kind === kind).length;
}

function countRel(edges: GraphEdge[], rel: GraphEdge["rel"]): number {
  return edges.filter((edge) => edge.rel === rel).length;
}

/**
 * Digest of the sources the graph is built from. `loadGraph` recomputes it, so
 * a stale graph is detectable without trusting timestamps already in the file.
 */
export async function computeSourceStamp(projectDirInput: string): Promise<GraphStamp> {
  const projectDir = path.resolve(projectDirInput);
  const files = (
    await fg(STAMP_GLOBS, {
      cwd: projectDir,
      ignore: IGNORED_GLOBS,
      onlyFiles: true,
      dot: false,
    })
  )
    .map(toPosix)
    .sort();

  const entries: string[] = [];
  for (const file of files) {
    try {
      const stats = await stat(path.join(projectDir, file));
      entries.push(`${file}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
    } catch {
      entries.push(`${file}:missing`);
    }
  }

  return {
    digest: createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16),
    files: files.length,
    builtAt: new Date().toISOString(),
  };
}

/**
 * Build the m1 + m2 + m3 graph for a native mini-program:
 * app.json + per-file JSON + every unit's `.wxml` and `.js`.
 */
export async function buildGraph(projectDirInput: string): Promise<Graph> {
  const projectDir = path.resolve(projectDirInput);
  const app = await readAppManifest(projectDir);
  const warnings: GraphWarning[] = [];

  const units = new Map<string, UnitNode>();
  for (const pageId of app.pages) {
    units.set(pageId, { kind: "page", id: pageId, file: `${pageId}.wxml` });
  }
  for (const subpackage of app.subpackages) {
    for (const pageId of subpackage.pages) {
      if (!units.has(pageId)) {
        units.set(pageId, { kind: "page", id: pageId, file: `${pageId}.wxml` });
      }
    }
  }

  const manifests = new Map<string, FileManifest>();
  const jsonFiles = await fg("**/*.json", {
    cwd: projectDir,
    ignore: IGNORED_GLOBS,
    onlyFiles: true,
    dot: false,
  });

  for (const relative of jsonFiles.map(toPosix).sort()) {
    let manifest: FileManifest;
    try {
      manifest = await readFileManifest(projectDir, relative);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push({
        code: "invalid_json",
        message: `could not parse ${relative}: ${reason}`,
        file: relative,
      });
      continue;
    }
    manifests.set(manifest.file, manifest);
    if (manifest.component) {
      const id = unitIdForManifest(manifest.file);
      if (!units.has(id)) {
        units.set(id, { kind: "component", id, file: `${id}.wxml` });
      }
    }
  }

  const states = new Map<string, UnitState>();
  const queue = [...units.keys()].sort();

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (states.has(id)) continue;
    const unit = units.get(id);
    if (unit === undefined) continue;

    let fileManifest = manifests.get(`${id}.json`);
    if (fileManifest === undefined) {
      const jsonPath = `${id}.json`;
      const source = await readOptionalFile(projectDir, jsonPath);
      if (source !== null) {
        try {
          fileManifest = parseFileManifest(jsonPath, source);
          manifests.set(fileManifest.file, fileManifest);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          warnings.push({
            code: "invalid_json",
            message: `could not parse ${jsonPath}: ${reason}`,
            file: jsonPath,
          });
        }
      }
    }

    const declarations = mergeDeclarations(
      app.usingComponents,
      fileManifest?.usingComponents ?? [],
    );
    const resolved = new Map<string, ResolvedSpecifier>();

    for (const declaration of declarations.values()) {
      const resolution = resolveComponentSpecifier(
        projectDir,
        declaration.file,
        declaration.specifier,
      );
      if (!resolution.ok) {
        warnings.push({
          code: "unresolved_component",
          message:
            `usingComponents["${declaration.tag}"] = "${declaration.specifier}" ` +
            `does not resolve: ${resolution.reason}`,
          file: declaration.file,
          line: declaration.line,
        });
        continue;
      }
      resolved.set(declaration.tag, resolution.target);
      if (!units.has(resolution.target.id)) {
        const target: UnitNode = {
          kind: "component",
          id: resolution.target.id,
          file: `${resolution.target.id}.wxml`,
        };
        units.set(target.id, target);
        queue.push(target.id);
      }
    }

    states.set(id, { unit, resolved });
  }

  // Parse every unit's template. Missing templates are not an error: a
  // logic-only component may legitimately have none.
  const parsedByUnit = new Map<string, ParsedWxml>();
  for (const id of [...states.keys()].sort()) {
    const unit = states.get(id)?.unit;
    if (unit === undefined) continue;
    const source = await readOptionalFile(projectDir, unit.file);
    if (source === null) continue;
    parsedByUnit.set(id, parseWxml(source, { file: unit.file, host: unit.id }));
  }

  const edges: GraphEdge[] = [];
  const nodes: GraphNode[] = [...units.values()];
  const elementHost = new Map<string, string>();

  for (const state of states.values()) {
    const parsed = parsedByUnit.get(state.unit.id);
    if (parsed !== undefined) {
      const firstUsage = new Map<string, { file: string; line: number }>();
      for (const element of parsed.elements) {
        elementHost.set(element.id, element.host);
        if (!firstUsage.has(element.tag)) {
          firstUsage.set(element.tag, { file: element.file, line: element.line });
        }
      }

      const included = new Set<string>();
      for (const [tag, target] of state.resolved) {
        const usage = firstUsage.get(tag);
        if (usage === undefined || included.has(target.id)) continue;
        included.add(target.id);
        edges.push({
          rel: "includes",
          from: state.unit.id,
          to: target.id,
          tag,
          file: usage.file,
          line: usage.line,
        });
      }

      nodes.push(...parsed.elements);
      edges.push(...parsed.contains, ...parsed.binds, ...parsed.handles);
    }
  }

  // m2: link page/component scripts to the nodes above.
  const scriptHandlerNames = new Map<string, Set<string>>();
  const cloudNodes = new Map<string, CloudFnNode>();
  const jsFiles = (
    await fg("**/*.js", {
      cwd: projectDir,
      ignore: IGNORED_GLOBS,
      onlyFiles: true,
      dot: false,
    })
  )
    .map(toPosix)
    .sort();

  // `.ts` sources are inside the project but outside the v0.1 grammar. They
  // are counted (and part of the source stamp) so the gap is visible in
  // `stats` instead of silent.
  const tsFiles = (
    await fg("**/*.ts", {
      cwd: projectDir,
      ignore: IGNORED_GLOBS,
      onlyFiles: true,
      dot: false,
    })
  )
    .map(toPosix)
    .sort();
  for (const relative of tsFiles) {
    warnings.push({
      code: "unsupported_ts",
      message:
        `${relative} is TypeScript; v0.1 analyses .js sources only, ` +
        `so this file contributes no nodes`,
      file: relative,
    });
  }

  // Every `.js` file the walk sees is parsed, not only the pages and
  // components: a utility file that fails to parse is still a gap in the
  // graph, and `stats` has to report it.
  let jsParsed = 0;
  let jsUnresolved = 0;
  for (const relative of jsFiles) {
    const ownerId = relative.replace(/\.js$/, "");
    const owner = units.get(ownerId);
    const source = await readOptionalFile(projectDir, relative);
    if (source === null) continue;

    const parsed = parseScript(source, { file: relative, owner: ownerId });
    if (!parsed.ok) {
      jsUnresolved += 1;
      warnings.push({ code: "unresolved_file", message: parsed.error, file: relative });
      continue;
    }
    jsParsed += 1;
    // A readable file no unit owns (a helper, an app-level module) is counted
    // and parsed but contributes no nodes.
    if (owner === undefined) continue;

    const script = parsed.script;
    // Only a readable Page/Component object makes the method set authoritative.
    if (script.rootKind !== null) {
      scriptHandlerNames.set(ownerId, new Set(script.handlers.map((handler) => handler.name)));
    }
    if (script.propertyNames.length > 0) {
      owner.properties = [...script.propertyNames].sort();
    }
    nodes.push(...script.handlers, ...script.setDataNodes);

    for (const site of script.setDataSites) {
      edges.push({
        rel: "calls_setdata",
        handler: site.handler?.id ?? ownerId,
        call: site.node.id,
        file: relative,
        line: site.node.line,
      });
    }

    for (const call of script.cloudCalls) {
      if (!cloudNodes.has(call.name)) {
        const node: CloudFnNode = { kind: "cloud_fn", name: call.name };
        cloudNodes.set(call.name, node);
        nodes.push(node);
      }
      edges.push({
        rel: "invokes",
        from: call.handler?.id ?? ownerId,
        to: call.name,
        file: relative,
        line: call.line,
      });
    }
  }

  // A handler attribute without a matching method is a warning, never an
  // edge. When a unit ships no readable script the method set is unknown, so
  // silence is the honest answer.
  for (const edge of edges) {
    if (edge.rel !== "handles") continue;
    const host = elementHost.get(edge.element);
    if (host === undefined) continue;
    const defined = scriptHandlerNames.get(host);
    if (defined === undefined || defined.has(edge.handler)) continue;
    warnings.push({
      code: "unresolved_handler",
      message:
        `handler "${edge.handler}" is bound at ${edge.file}:${edge.line} ` +
        `but ${host}.js defines no method of that name`,
      file: edge.file,
      line: edge.line,
    });
  }

  for (const subpackage of app.subpackages) {
    for (const unit of units.values()) {
      if (!unit.id.startsWith(`${subpackage.root}/`)) continue;
      edges.push({
        rel: "in_subpackage",
        from: unit.id,
        to: subpackageId(subpackage.root),
        root: subpackage.root,
        file: "app.json",
        line: subpackage.line,
      });
    }
  }

  const uniqueEdges = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (!uniqueEdges.has(key)) uniqueEdges.set(key, edge);
  }

  // m3: resolve data paths and close the owned rerenders edge.
  const resolution = resolveGraph({ nodes, edges: [...uniqueEdges.values()] });

  const dataFields = new Map<string, DataFieldNode>();
  for (const unit of resolution.units.values()) {
    for (const binding of unit.bindings) {
      const key = `${unit.node.id}:${binding.path}`;
      if (!dataFields.has(key)) {
        dataFields.set(key, {
          kind: "data_field",
          owner: unit.node.id,
          path: binding.path,
        });
      }
    }
  }
  nodes.push(...dataFields.values());

  for (const edge of resolution.rerenders) {
    const key = edgeKey(edge);
    if (!uniqueEdges.has(key)) uniqueEdges.set(key, edge);
  }
  const sortedEdges = [...uniqueEdges.values()].sort(compareEdges);

  const uniqueWarnings = new Map<string, GraphWarning>();
  for (const warning of warnings) {
    const key = warningKey(warning);
    if (!uniqueWarnings.has(key)) uniqueWarnings.set(key, warning);
  }
  const sortedWarnings = sortWarnings([...uniqueWarnings.values()]);

  const sortedNodes = nodes.sort(compareNodes);

  const graph: Graph = {
    schemaVersion: 1,
    subpackages: app.subpackages.map((subpackage) => ({
      root: subpackage.root,
      independent: subpackage.independent,
      pages: subpackage.pages.filter((page) => units.get(page)?.kind === "page"),
    })),
    nodes: sortedNodes,
    edges: sortedEdges,
    warnings: sortedWarnings,
    stats: {
      subpackages: app.subpackages.length,
      pages: countKind(sortedNodes, "page"),
      components: countKind(sortedNodes, "component"),
      elements: countKind(sortedNodes, "element"),
      data_fields: countKind(sortedNodes, "data_field"),
      handlers: countKind(sortedNodes, "handler"),
      set_data: countKind(sortedNodes, "set_data"),
      cloud_fns: countKind(sortedNodes, "cloud_fn"),
      nodes: sortedNodes.length,
      edges: sortedEdges.length,
      binds: countRel(sortedEdges, "binds"),
      handles: countRel(sortedEdges, "handles"),
      calls_setdata: countRel(sortedEdges, "calls_setdata"),
      rerenders: countRel(sortedEdges, "rerenders"),
      js_files: jsFiles.length,
      js_parsed: jsParsed,
      js_unresolved: jsUnresolved,
      ts_files: tsFiles.length,
    },
    stamp: await computeSourceStamp(projectDir),
  };

  return graph;
}

/** Build the graph and write it as one JSON file. */
export async function writeGraph(
  projectDir: string,
  outFile = path.join(projectDir, ".wxgraph", "graph.json"),
): Promise<Graph> {
  const graph = await buildGraph(projectDir);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return graph;
}

export type GraphLoad =
  | { status: "ok"; graph: Graph; graphFile: string }
  | { status: "missing"; graphFile: string }
  | { status: "stale"; graphFile: string; reason: string };

/**
 * Read `.wxgraph/graph.json` and compare its stamp with the sources on disk.
 * A missing, unreadable or stale graph must never be answered from.
 */
export async function loadGraph(
  projectDirInput: string,
  graphFile = path.join(projectDirInput, ".wxgraph", "graph.json"),
): Promise<GraphLoad> {
  const projectDir = path.resolve(projectDirInput);
  let source: string;
  try {
    source = await readFile(graphFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", graphFile };
    }
    return { status: "stale", graphFile, reason: "graph.json is not readable" };
  }

  let graph: Graph;
  try {
    graph = JSON.parse(source) as Graph;
  } catch {
    return { status: "stale", graphFile, reason: "graph.json is not valid JSON" };
  }
  if (graph === null || typeof graph !== "object" || !Array.isArray(graph.nodes)) {
    return { status: "stale", graphFile, reason: "graph.json does not look like a graph" };
  }
  if (graph.stamp === undefined) {
    return { status: "stale", graphFile, reason: "graph.json has no source stamp" };
  }

  const current = await computeSourceStamp(projectDir);
  if (current.digest !== graph.stamp.digest) {
    return { status: "stale", graphFile, reason: "sources changed since the last build" };
  }
  return { status: "ok", graph, graphFile };
}
