import { parseHandlerAttribute } from "../parse/wxml";
import type {
  BindsEdge,
  ElementNode,
  Graph,
  RerendersEdge,
  SetDataNode,
  UnitNode,
} from "./schema";

/** A `binds` edge whose field has been resolved through its `wx:for` scopes. */
export interface ResolvedBinding {
  unit: string;
  element: string;
  attr: string;
  /** Path as written in the template. */
  field: string;
  /** Path in the owning unit's data, e.g. `items[].unitPrice`. */
  path: string;
  expr: string;
  file: string;
  line: number;
}

export interface UnitIndex {
  node: UnitNode;
  elements: Map<string, ElementNode>;
  /** Element id -> containing element id, or the unit id at the root. */
  parents: Map<string, string>;
  bindings: ResolvedBinding[];
  /** WXML tag -> component unit id, from the m1 `includes` edges. */
  components: Map<string, string>;
  setData: SetDataNode[];
}

export type AttemptStatus =
  | "resolved"
  | "non_literal"
  | "no_binding"
  | "unknown_property"
  | "no_child_binding";

/**
 * One explanation step for a `setData` key. Resolved attempts become
 * `rerenders` edges; every other status is proof that no edge was invented.
 */
export interface RerenderAttempt {
  call: string;
  owner: string;
  /** Script file of the call site. */
  file: string;
  line: number;
  key: string | null;
  status: AttemptStatus;
  /** `direct` or `prop:<name>` once resolved. */
  via?: string;
  element?: string;
  /** The binding that consumed the key in the call's own unit. */
  matched?: ResolvedBinding;
  detail: string;
}

export interface Resolution {
  units: Map<string, UnitIndex>;
  attempts: RerenderAttempt[];
  rerenders: RerendersEdge[];
}

const LOCAL_ATTRIBUTES = new Set(["#text", "class", "style", "id", "slot", "hidden"]);

/**
 * Attributes whose value stays in the declaring template: text, universal
 * attributes, directives and dynamic handler names. Only a real property pass
 * (`price="{{...}}"`) may cross into a child component.
 */
function isLocalAttribute(attr: string): boolean {
  if (LOCAL_ATTRIBUTES.has(attr)) return true;
  if (attr.startsWith("wx:") || attr.startsWith("data-")) return true;
  // Handler attributes (both spellings) never carry a component property.
  return parseHandlerAttribute(attr) !== null;
}

/** Normalise a data path: no `this.`, numeric indexes collapsed to `[]`. */
export function normalizeDataPath(value: string): string {
  return value
    .trim()
    .replace(/^this\./, "")
    .replace(/\[\s*\d+\s*\]/g, "[]")
    .replace(/\[\s*'([^']+)'\s*\]/g, ".$1")
    .replace(/\[\s*"([^"]+)"\s*\]/g, ".$1");
}

/** True when `path` is `key` or a child of it (`items` covers `items[].x`). */
export function isWithinKey(key: string, path: string): boolean {
  if (path === key) return true;
  if (!path.startsWith(key)) return false;
  const next = path[key.length];
  return next === "." || next === "[";
}

function camelize(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

const ROOT_SEGMENT = /^[A-Za-z_$][\w$]*/;

function splitRoot(path: string): { root: string; rest: string } {
  const match = ROOT_SEGMENT.exec(path);
  if (match === null) return { root: path, rest: "" };
  return { root: match[0], rest: path.slice(match[0].length) };
}

function resolveIn(
  unit: UnitIndex,
  elementId: string | null,
  field: string,
  depth: number,
): string {
  const path = normalizeDataPath(field);
  if (depth > 32 || elementId === null) return path;
  const element = unit.elements.get(elementId);
  if (element === undefined) return path;

  if (element.for !== undefined) {
    const { root, rest } = splitRoot(path);
    if (root === element.for.item || root === element.for.index) {
      const parent = unit.parents.get(elementId) ?? null;
      const scopeStart = parent !== null && unit.elements.has(parent) ? parent : null;
      const base = resolveIn(unit, scopeStart, element.for.source, depth + 1);
      if (root === element.for.index && rest.startsWith("[")) return `${base}${rest}`;
      return `${base}[]${rest}`;
    }
  }

  const parent = unit.parents.get(elementId);
  if (parent === undefined || !unit.elements.has(parent)) return path;
  return resolveIn(unit, parent, path, depth + 1);
}

function resolveBinding(unit: UnitIndex, edge: BindsEdge): ResolvedBinding {
  // A `wx:for` source is evaluated in the parent scope, not in the scope it
  // introduces.
  const startsAtForScope = edge.attr === "wx:for";
  let start: string | null;
  if (startsAtForScope) {
    const parent = unit.parents.get(edge.element);
    start = parent !== undefined && unit.elements.has(parent) ? parent : null;
  } else {
    start = edge.element;
  }
  return {
    unit: unit.node.id,
    element: edge.element,
    attr: edge.attr,
    field: edge.field,
    path: resolveIn(unit, start, edge.field, 0),
    expr: edge.expr,
    file: edge.file,
    line: edge.line,
  };
}

interface PropertyHop {
  element: ElementNode;
  path: string;
}

interface PropertyHopResult {
  hops: PropertyHop[];
  /** First property the child script declares itself not to accept. */
  blockedBy: string | null;
}

/**
 * Follow a custom-component property into the child template.
 *
 * The attribute name is the property name at the first hop (kebab-case is
 * accepted for camelCase properties); deeper hops carry the attribute of the
 * nested custom-component tag. When the child script declares its `properties`
 * and this attribute is not one of them, the hop is refused: the platform
 * drops undeclared attributes, so an edge would be wrong. Only elements
 * actually bound to the property are returned.
 */
function followProperty(
  units: Map<string, UnitIndex>,
  unitId: string,
  property: string,
  depth: number,
  visited: Set<string>,
): PropertyHopResult {
  if (depth > 4) return { hops: [], blockedBy: null };
  const unit = units.get(unitId);
  if (unit === undefined) return { hops: [], blockedBy: null };

  const declared = unit.node.properties;
  if (declared !== undefined && declared.length > 0) {
    const accepted = new Set(declared.map(camelize));
    if (!accepted.has(camelize(property))) return { hops: [], blockedBy: property };
  }

  const visitKey = `${unitId}\u0000${property}`;
  if (visited.has(visitKey)) return { hops: [], blockedBy: null };

  const nextVisited = new Set(visited);
  nextVisited.add(visitKey);

  const names = new Set([property, camelize(property)]);
  const hops: PropertyHop[] = [];
  let blockedBy: string | null = null;
  for (const binding of unit.bindings) {
    let matched = false;
    for (const name of names) {
      if (isWithinKey(name, binding.path)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;

    const element = unit.elements.get(binding.element);
    if (element === undefined) continue;

    const nested = unit.components.get(element.tag);
    const carriesProperty = binding.attr !== "" && !isLocalAttribute(binding.attr);
    if (nested !== undefined && carriesProperty) {
      const deeper = followProperty(units, nested, binding.attr, depth + 1, nextVisited);
      hops.push(...deeper.hops);
      blockedBy = blockedBy ?? deeper.blockedBy;
      continue;
    }
    hops.push({ element, path: binding.path });
  }
  return { hops, blockedBy };
}

function indexGraph(graph: Pick<Graph, "nodes" | "edges">): {
  units: Map<string, UnitIndex>;
  elementToUnit: Map<string, UnitIndex>;
} {
  const units = new Map<string, UnitIndex>();
  for (const node of graph.nodes) {
    if (node.kind === "page" || node.kind === "component") {
      units.set(node.id, {
        node,
        elements: new Map(),
        parents: new Map(),
        bindings: [],
        components: new Map(),
        setData: [],
      });
    }
  }

  const elementToUnit = new Map<string, UnitIndex>();
  for (const node of graph.nodes) {
    if (node.kind === "element") {
      const unit = units.get(node.host);
      if (unit === undefined) continue;
      unit.elements.set(node.id, node);
      elementToUnit.set(node.id, unit);
    } else if (node.kind === "set_data") {
      units.get(node.owner)?.setData.push(node);
    }
  }

  for (const edge of graph.edges) {
    switch (edge.rel) {
      case "contains": {
        elementToUnit.get(edge.to)?.parents.set(edge.to, edge.from);
        break;
      }
      case "binds": {
        const unit = elementToUnit.get(edge.element);
        if (unit !== undefined) unit.bindings.push(resolveBinding(unit, edge));
        break;
      }
      case "includes": {
        units.get(edge.from)?.components.set(edge.tag, edge.to);
        break;
      }
      default:
        break;
    }
  }

  return { units, elementToUnit };
}

/**
 * Resolve the m2 facts into the owned `rerenders` edge.
 *
 * The chain a `rerenders` edge asserts is: `setData` key -> data path in the
 * call's unit -> host element attribute -> custom-component property -> child
 * binding -> element. Every hop must resolve; when one does not, the attempt
 * is recorded with a status and no edge is produced.
 */
export function resolveGraph(graph: Pick<Graph, "nodes" | "edges">): Resolution {
  const { units } = indexGraph(graph);
  const attempts: RerenderAttempt[] = [];
  const rerenders: RerendersEdge[] = [];
  const seen = new Set<string>();

  const emit = (attempt: RerenderAttempt, element: ElementNode, via: string): void => {
    const key = `${attempt.call}\u0000${element.id}\u0000${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    rerenders.push({
      rel: "rerenders",
      call: attempt.call,
      element: element.id,
      via,
      file: attempt.file,
      line: attempt.line,
    });
  };

  for (const unit of units.values()) {
    for (const call of unit.setData) {
      const file = `${call.owner}.js`;
      const base = { call: call.id, owner: call.owner, file, line: call.line };

      if (call.keys === null) {
        attempts.push({
          ...base,
          key: null,
          status: "non_literal",
          detail: `${file}:${call.line} passes a non-literal argument; keys are unknown`,
        });
        continue;
      }

      for (const rawKey of call.keys) {
        const key = normalizeDataPath(rawKey);
        const matches = unit.bindings.filter((binding) => isWithinKey(key, binding.path));

        if (matches.length === 0) {
          attempts.push({
            ...base,
            key,
            status: "no_binding",
            detail: `no binding in ${unit.node.file} reads "${key}"`,
          });
          continue;
        }

        for (const match of matches) {
          const element = unit.elements.get(match.element);
          if (element === undefined) continue;

          const component = unit.components.get(element.tag);
          const staysLocal = component === undefined || isLocalAttribute(match.attr);

          if (staysLocal) {
            const attempt: RerenderAttempt = {
              ...base,
              key,
              status: "resolved",
              via: "direct",
              element: element.id,
              matched: match,
              detail: `"${key}" -> ${match.path} -> <${element.tag}> ${element.file}:${element.line}`,
            };
            attempts.push(attempt);
            emit(attempt, element, "direct");
            continue;
          }

          const property = match.attr;
          const hop = followProperty(units, component, property, 0, new Set());
          if (hop.blockedBy !== null) {
            attempts.push({
              ...base,
              key,
              status: "unknown_property",
              matched: match,
              detail:
                `${component} does not declare a property "${hop.blockedBy}"; ` +
                `the platform drops the attribute, so no edge`,
            });
            continue;
          }
          if (hop.hops.length === 0) {
            attempts.push({
              ...base,
              key,
              status: "no_child_binding",
              matched: match,
              detail:
                `${element.tag} is ${component}, but no child binding reads property ` +
                `"${property}"`,
            });
            continue;
          }

          for (const rendered of hop.hops) {
            const attempt: RerenderAttempt = {
              ...base,
              key,
              status: "resolved",
              via: `prop:${property}`,
              element: rendered.element.id,
              matched: match,
              detail:
                `"${key}" -> ${match.path} -> <${element.tag} ${property}> -> ` +
                `<${rendered.element.tag}> ${rendered.path} ` +
                `${rendered.element.file}:${rendered.element.line}`,
            };
            attempts.push(attempt);
            emit(attempt, rendered.element, `prop:${property}`);
          }
        }
      }
    }
  }

  return { units, attempts, rerenders };
}
