import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { parseWxml, type ParsedWxml } from "../parse/wxml";
import {
  subpackageId,
  type Graph,
  type GraphEdge,
  type GraphNode,
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
      return `${node.owner}:${node.name}:${node.line}`;
    case "set_data":
      return `${node.owner}:${node.line}`;
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

/**
 * Build the m1 graph for a native mini-program:
 * app.json + per-file JSON + every declared unit's `.wxml`.
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

  for (const state of states.values()) {
    const parsed = parsedByUnit.get(state.unit.id);
    if (parsed !== undefined) {
      const firstUsage = new Map<string, { file: string; line: number }>();
      for (const element of parsed.elements) {
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
      pages: sortedNodes.filter((node) => node.kind === "page").length,
      components: sortedNodes.filter((node) => node.kind === "component").length,
      elements: sortedNodes.filter((node) => node.kind === "element").length,
      nodes: sortedNodes.length,
      edges: sortedEdges.length,
      binds: sortedEdges.filter((edge) => edge.rel === "binds").length,
      handles: sortedEdges.filter((edge) => edge.rel === "handles").length,
    },
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
