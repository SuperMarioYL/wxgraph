/**
 * Shared graph model.
 *
 * Six node kinds and the edge kinds from the v0.1 plan. The manifest/WXML pass
 * (m1) produces page and component units, WXML elements, and the contains,
 * includes, in_subpackage, binds and handles edges. Later passes attach data
 * fields, handlers, setData calls, cloud functions, invokes, calls_setdata and
 * the owned rerenders edge.
 */

export type UnitKind = "page" | "component";

/** A `wx:for` scope declared on an element and inherited by its children. */
export interface ForScope {
  /** `wx:for` expression, without the moustache braces. */
  source: string;
  /** `wx:for-item` alias (defaults to "item"). */
  item: string;
  /** `wx:for-index` alias (defaults to "index"). */
  index: string;
  /** `wx:key` as written, or null when absent. */
  key: string | null;
}

export interface UnitNode {
  kind: UnitKind;
  /** Project-relative path without an extension, e.g. "pages/cart/index". */
  id: string;
  /**
   * Project-relative template path, e.g. "pages/cart/index.wxml". This is the
   * conventional path even when the file does not exist.
   */
  file: string;
}

export interface ElementNode {
  kind: "element";
  /** `<file>:<line>:<tag>`, with a numeric suffix when that triple repeats. */
  id: string;
  file: string;
  line: number;
  tag: string;
  /** Unit id of the template that owns this element. */
  host: string;
  for?: ForScope;
  /** `wx:if` condition, without the moustache braces. */
  if?: string;
  /** `slot="..."` assignment on this element. */
  slot?: string;
  /** `name="..."` on a `<slot>` definition. */
  slotName?: string;
}

export interface DataFieldNode {
  kind: "data_field";
  owner: string;
  /** Normalised path, e.g. "items[].unitPrice". */
  path: string;
}

export interface HandlerNode {
  kind: "handler";
  owner: string;
  name: string;
  line: number;
}

export interface SetDataNode {
  kind: "set_data";
  owner: string;
  /** null when the argument is not an object literal. */
  keys: string[] | null;
  line: number;
}

export interface CloudFnNode {
  kind: "cloud_fn";
  name: string;
}

export type GraphNode =
  | UnitNode
  | ElementNode
  | DataFieldNode
  | HandlerNode
  | SetDataNode
  | CloudFnNode;

/** Every edge carries the source location that justifies it. */
export interface SourceLocation {
  file: string;
  line: number;
}

export type ContainsEdge = SourceLocation & {
  rel: "contains";
  /** Unit id for a root element, parent element id otherwise. */
  from: string;
  to: string;
};

export type IncludesEdge = SourceLocation & {
  rel: "includes";
  /** Hosting unit id. */
  from: string;
  /** Component unit id. */
  to: string;
  /** The WXML tag that triggered the inclusion. */
  tag: string;
};

export type InSubpackageEdge = SourceLocation & {
  rel: "in_subpackage";
  from: string;
  /**
   * `subpackage:<root>` — a named packaging scope, declared in
   * `graph.subpackages`, not a node in `graph.nodes`.
   */
  to: string;
  root: string;
};

export type InvokesEdge = SourceLocation & {
  rel: "invokes";
  from: string;
  to: string;
};

export type BindsEdge = SourceLocation & {
  rel: "binds";
  element: string;
  /** Attribute name, or "#text" for an interpolation in text content. */
  attr: string;
  /** Extracted data path, e.g. "item.unitPrice". */
  field: string;
  /** Full expression, without the moustache braces. */
  expr: string;
};

export type HandlesEdge = SourceLocation & {
  rel: "handles";
  element: string;
  /** Handler method name as written in the attribute. */
  handler: string;
  /** Bare event name, e.g. "tap". */
  event: string;
  /** bind | catch | capture-bind | capture-catch | mut-bind */
  modifier: string;
};

export type CallsSetDataEdge = SourceLocation & {
  rel: "calls_setdata";
  handler: string;
  call: string;
};

export type RerendersEdge = SourceLocation & {
  rel: "rerenders";
  call: string;
  element: string;
  /** "direct" or "prop:<name>". */
  via: string;
};

export type GraphEdge =
  | ContainsEdge
  | IncludesEdge
  | InSubpackageEdge
  | InvokesEdge
  | BindsEdge
  | HandlesEdge
  | CallsSetDataEdge
  | RerendersEdge;

export interface SubpackageInfo {
  root: string;
  independent: boolean;
  /** Page unit ids declared by this subpackage. */
  pages: string[];
}

export type WarningCode = "unresolved_component" | "invalid_json";

export interface GraphWarning {
  code: WarningCode;
  message: string;
  file?: string;
  line?: number;
}

export interface GraphStats {
  subpackages: number;
  pages: number;
  components: number;
  elements: number;
  nodes: number;
  edges: number;
  binds: number;
  handles: number;
}

export interface Graph {
  schemaVersion: 1;
  subpackages: SubpackageInfo[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: GraphWarning[];
  stats: GraphStats;
}

/** Target id used by `in_subpackage` edges. */
export function subpackageId(root: string): string {
  return `subpackage:${root}`;
}
