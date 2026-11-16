import type { Graph, GraphNode } from "../graph/schema";

export interface SearchHit {
  kind: GraphNode["kind"];
  /** The graph id or the closest stable label for the node. */
  id: string;
  /** What to show next to the kind, e.g. `pages/cart/index:20  setData({items})`. */
  label: string;
  file: string | null;
  line: number | null;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** Matches before `limit` was applied. */
  total: number;
}

const KIND_RANK: Record<GraphNode["kind"], number> = {
  page: 0,
  component: 1,
  element: 2,
  data_field: 3,
  handler: 4,
  set_data: 5,
  cloud_fn: 6,
};

interface NodeText {
  id: string;
  label: string;
  /** Every string a query may match: ids, paths, tags, keys, names. */
  haystack: string[];
  file: string | null;
  line: number | null;
}

function nodeText(node: GraphNode): NodeText {
  switch (node.kind) {
    case "page":
    case "component":
      return {
        id: node.id,
        label: `${node.id}  ${node.file}`,
        haystack: [node.id, node.file],
        file: node.file,
        line: null,
      };
    case "element":
      return {
        id: node.id,
        label: `<${node.tag}>  ${node.file}:${node.line}`,
        haystack: [node.id, node.tag, node.host],
        file: node.file,
        line: node.line,
      };
    case "data_field":
      return {
        id: `${node.owner}:${node.path}`,
        label: `${node.owner}:${node.path}`,
        haystack: [node.owner, node.path],
        file: null,
        line: null,
      };
    case "handler":
      return {
        id: node.id,
        label: `${node.name}()  ${node.owner}.js:${node.line}`,
        haystack: [node.id, node.name, node.owner],
        file: `${node.owner}.js`,
        line: node.line,
      };
    case "set_data":
      return {
        id: node.id,
        label:
          `${node.owner}.js:${node.line}  ` +
          (node.keys === null ? "setData(<non-literal>)" : `setData({${node.keys.join(", ")}})`),
        haystack: [node.id, node.owner, ...(node.keys ?? [])],
        file: `${node.owner}.js`,
        line: node.line,
      };
    case "cloud_fn":
      return {
        id: node.name,
        label: `cloud function ${node.name}`,
        haystack: [node.name],
        file: null,
        line: null,
      };
  }
}

/**
 * Case-insensitive substring search over every node's ids, paths, tags and
 * keys. This is the discovery step before `impact`: find the exact id to ask
 * about without reading files.
 */
export function searchGraph(graph: Graph, rawQuery: string, limit = 50): SearchResult {
  const query = rawQuery.trim();
  if (query === "") throw new Error("search needs a non-empty query");
  const needle = query.toLowerCase();

  const hits: SearchHit[] = [];
  for (const node of graph.nodes) {
    const text = nodeText(node);
    if (!text.haystack.some((value) => value.toLowerCase().includes(needle))) continue;
    hits.push({
      kind: node.kind,
      id: text.id,
      label: text.label,
      file: text.file,
      line: text.line,
    });
  }

  hits.sort((left, right) => {
    const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind];
    if (rank !== 0) return rank;
    return left.label.localeCompare(right.label);
  });

  return { query, hits: hits.slice(0, limit), total: hits.length };
}

/** Render search results as one line per hit, kind first. */
export function formatSearch(result: SearchResult, limit = 50): string {
  const lines: string[] = [];
  const noun = result.total === 1 ? "match" : "matches";
  lines.push(`${result.total} ${noun} for "${result.query}"`);
  if (result.total === 0) return `${lines.join("\n")}\n`;
  lines.push("");
  const width = Math.max(...result.hits.map((hit) => hit.kind.length));
  for (const hit of result.hits) {
    lines.push(`${hit.kind.padEnd(width)}  ${hit.label}`);
  }
  if (result.total > limit) {
    lines.push("");
    lines.push(`(showing the first ${limit}; narrow the query for the rest)`);
  }
  return `${lines.join("\n")}\n`;
}
