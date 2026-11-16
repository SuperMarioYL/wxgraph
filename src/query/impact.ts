import type {
  ElementNode,
  Graph,
  HandlerNode,
  IncludesEdge,
  SetDataNode,
  UnitKind,
  UnitNode,
} from "../graph/schema";
import { normalizeUnitPath } from "../parse/manifest";
import {
  resolveGraph,
  type AttemptStatus,
  type Resolution,
  type ResolvedBinding,
  type RerenderAttempt,
} from "../graph/resolve";

export interface ImpactTarget {
  id: string;
  kind: UnitKind | "element";
  file: string | null;
}

export interface HostPass {
  attr: string;
  expr: string;
  path: string;
  file: string;
  line: number;
}

export interface ImpactHost {
  host: string;
  kind: UnitKind;
  tag: string;
  /** Location of the first usage of the tag. */
  file: string;
  line: number;
  element: string;
  passes: HostPass[];
}

export interface ImpactRerender {
  callId: string;
  owner: string;
  file: string;
  line: number;
  keys: string[] | null;
  handler: { name: string; file: string; line: number } | null;
  element: string;
  elementFile: string;
  elementLine: number;
  elementTag: string;
  via: string;
}

export interface ImpactUnresolved {
  owner: string;
  file: string;
  line: number;
  handler: string | null;
}

/** A `setData` key whose path did not resolve, reported instead of guessed. */
export interface ImpactUnresolvedHop {
  owner: string;
  callId: string;
  file: string;
  line: number;
  key: string;
  status: Exclude<AttemptStatus, "resolved" | "non_literal">;
  detail: string;
  handler: string | null;
}

export interface ImpactResult {
  target: string;
  kind: UnitKind | "element";
  file: string | null;
  hosts: ImpactHost[];
  rerenders: ImpactRerender[];
  unresolvedSetData: ImpactUnresolved[];
  unresolvedHops: ImpactUnresolvedHop[];
}

function isUnit(node: { kind: string }): node is UnitNode {
  return node.kind === "page" || node.kind === "component";
}

/**
 * Accept a unit id ("components/price-card"), a file path
 * ("components/price-card.wxml"), or an exact element id.
 */
export function findImpactTarget(graph: Graph, raw: string): ImpactTarget {
  const value = raw.trim();
  if (value === "") throw new Error("impact needs a page, component or element");

  const element = graph.nodes.find(
    (node): node is ElementNode =>
      node.kind === "element" && (node.id === value || node.id === value.replace(/^\.\//, "")),
  );
  if (element !== undefined) {
    return { id: element.id, kind: "element", file: element.file };
  }

  const normalized = normalizeUnitPath(value);
  const units = graph.nodes.filter(isUnit);
  const exact = units.find((unit) => unit.id === normalized);
  if (exact !== undefined) return { id: exact.id, kind: exact.kind, file: exact.file };

  const suffixed = units.filter(
    (unit) => unit.id === normalized || unit.id.endsWith(`/${normalized}`),
  );
  if (suffixed.length === 1) {
    return { id: suffixed[0].id, kind: suffixed[0].kind, file: suffixed[0].file };
  }
  if (suffixed.length > 1) {
    const options = suffixed.map((unit) => unit.id).sort().join(", ");
    throw new Error(`"${value}" is ambiguous: ${options}`);
  }
  throw new Error(`no page, component or element matches "${value}"`);
}

interface Maps {
  units: Map<string, UnitNode>;
  elements: Map<string, ElementNode>;
  handlers: Map<string, HandlerNode>;
  calls: Map<string, SetDataNode>;
  callHandler: Map<string, string>;
}

function buildMaps(graph: Graph): Maps {
  const units = new Map<string, UnitNode>();
  const elements = new Map<string, ElementNode>();
  const handlers = new Map<string, HandlerNode>();
  const calls = new Map<string, SetDataNode>();
  const callHandler = new Map<string, string>();

  for (const node of graph.nodes) {
    if (isUnit(node)) units.set(node.id, node);
    else if (node.kind === "element") elements.set(node.id, node);
    else if (node.kind === "handler") handlers.set(node.id, node);
    else if (node.kind === "set_data") calls.set(node.id, node);
  }
  for (const edge of graph.edges) {
    if (edge.rel === "calls_setdata") {
      callHandler.set(edge.call, edge.handler);
    }
  }
  return { units, elements, handlers, calls, callHandler };
}

function toRerender(
  attempt: RerenderAttempt,
  maps: Maps,
): ImpactRerender | null {
  const call = maps.calls.get(attempt.call);
  const element = attempt.element === undefined ? undefined : maps.elements.get(attempt.element);
  if (call === undefined || element === undefined || attempt.via === undefined) return null;
  const handlerId = maps.callHandler.get(call.id);
  const handler = handlerId === undefined ? undefined : maps.handlers.get(handlerId);
  return {
    callId: call.id,
    owner: call.owner,
    file: attempt.file,
    line: attempt.line,
    keys: call.keys,
    handler:
      handler === undefined
        ? null
        : { name: handler.name, file: `${handler.owner}.js`, line: handler.line },
    element: element.id,
    elementFile: element.file,
    elementLine: element.line,
    elementTag: element.tag,
    via: attempt.via,
  };
}

function hostPasses(
  resolution: Resolution,
  hostId: string,
  elementId: string,
): HostPass[] {
  const unit = resolution.units.get(hostId);
  if (unit === undefined) return [];
  const bindings: ResolvedBinding[] = unit.bindings.filter(
    (binding) => binding.element === elementId,
  );
  return bindings.map((binding) => ({
    attr: binding.attr,
    expr: binding.expr,
    path: binding.path,
    file: binding.file,
    line: binding.line,
  }));
}

function dedupeRerenders(rerenders: ImpactRerender[]): ImpactRerender[] {
  const seen = new Set<string>();
  const out: ImpactRerender[] = [];
  for (const item of rerenders) {
    const key = `${item.callId}\u0000${item.element}\u0000${item.via}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * True when the failed attempt was trying to cross into `unitId`: it bound a
 * data path to a tag that resolves to that component.
 */
function attemptCrossesInto(
  attempt: RerenderAttempt,
  unitId: string,
  resolution: Resolution,
): boolean {
  if (attempt.matched === undefined) return false;
  const unit = resolution.units.get(attempt.owner);
  const element = unit?.elements.get(attempt.matched.element);
  return element !== undefined && unit?.components.get(element.tag) === unitId;
}

function toUnresolvedHop(
  attempt: RerenderAttempt,
  maps: Maps,
): ImpactUnresolvedHop | null {
  if (attempt.key === null) return null;
  if (attempt.status === "resolved" || attempt.status === "non_literal") return null;
  const handlerId = maps.callHandler.get(attempt.call);
  const handler = handlerId === undefined ? undefined : maps.handlers.get(handlerId);
  return {
    owner: attempt.owner,
    callId: attempt.call,
    file: attempt.file,
    line: attempt.line,
    key: attempt.key,
    status: attempt.status,
    detail: attempt.detail,
    handler: handler?.name ?? null,
  };
}

/**
 * Answer "if this component changes, what re-renders and why".
 *
 * The result is the `rerenders` closure touching the target: edges that land
 * on elements the target owns, plus edges the target's own `setData` calls
 * produce. Non-literal `setData` sites and hops that failed to resolve are
 * listed instead of guessed.
 */
export function computeImpact(
  graph: Graph,
  rawTarget: string,
  resolution: Resolution = resolveGraph(graph),
): ImpactResult {
  const target = findImpactTarget(graph, rawTarget);
  const maps = buildMaps(graph);
  const result: ImpactResult = {
    target: target.id,
    kind: target.kind,
    file: target.file,
    hosts: [],
    rerenders: [],
    unresolvedSetData: [],
    unresolvedHops: [],
  };

  if (target.kind === "element") {
    result.rerenders = dedupeRerenders(
      resolution.attempts
        .filter((attempt) => attempt.status === "resolved" && attempt.element === target.id)
        .map((attempt) => toRerender(attempt, maps))
        .filter((item): item is ImpactRerender => item !== null),
    );
    return result;
  }

  const targetUnit = maps.units.get(target.id);
  if (targetUnit === undefined) throw new Error(`unknown unit "${target.id}"`);

  const hosts: ImpactHost[] = [];
  for (const edge of graph.edges) {
    if (edge.rel !== "includes" || edge.to !== target.id) continue;
    const host = maps.units.get(edge.from);
    if (host === undefined) continue;

    const element =
      [...maps.elements.values()].find(
        (candidate) =>
          candidate.host === host.id &&
          candidate.tag === edge.tag &&
          candidate.file === edge.file &&
          candidate.line === edge.line,
      ) ?? [...maps.elements.values()].find((candidate) => candidate.host === host.id && candidate.tag === edge.tag);
    if (element === undefined) continue;

    hosts.push({
      host: host.id,
      kind: host.kind,
      tag: edge.tag,
      file: edge.file,
      line: edge.line,
      element: element.id,
      passes: hostPasses(resolution, host.id, element.id),
    });
  }
  hosts.sort((left, right) => left.host.localeCompare(right.host));
  result.hosts = hosts;

  const rerenders: ImpactRerender[] = [];
  for (const attempt of resolution.attempts) {
    if (attempt.status !== "resolved") continue;
    const element = attempt.element === undefined ? undefined : maps.elements.get(attempt.element);
    if (element === undefined) continue;
    if (element.host !== target.id && attempt.owner !== target.id) continue;
    const rendered = toRerender(attempt, maps);
    if (rendered !== null) rerenders.push(rendered);
  }
  rerenders.sort((left, right) => {
    if (left.elementFile !== right.elementFile) {
      return left.elementFile.localeCompare(right.elementFile);
    }
    if (left.elementLine !== right.elementLine) return left.elementLine - right.elementLine;
    return left.callId.localeCompare(right.callId);
  });
  result.rerenders = dedupeRerenders(rerenders);

  const hostIds = new Set(hosts.map((host) => host.host));
  for (const attempt of resolution.attempts) {
    if (attempt.status !== "non_literal") continue;
    if (attempt.owner !== target.id && !hostIds.has(attempt.owner)) continue;
    const handlerId = maps.callHandler.get(attempt.call);
    const handler = handlerId === undefined ? undefined : maps.handlers.get(handlerId);
    result.unresolvedSetData.push({
      owner: attempt.owner,
      file: attempt.file,
      line: attempt.line,
      handler: handler?.name ?? null,
    });
  }

  // A hop that failed on the target's own data, or on a host attribute that
  // feeds this component, is part of the answer: the miss must never be
  // silent. Attempts elsewhere in the project stay out of this result.
  for (const attempt of resolution.attempts) {
    if (attempt.owner !== target.id && !attemptCrossesInto(attempt, target.id, resolution)) {
      continue;
    }
    const hop = toUnresolvedHop(attempt, maps);
    if (hop !== null) result.unresolvedHops.push(hop);
  }
  result.unresolvedHops.sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    if (left.line !== right.line) return left.line - right.line;
    return left.key.localeCompare(right.key);
  });

  return result;
}

export interface ImpactUpDependent {
  id: string;
  kind: UnitKind;
  /** 1 for a direct host, 2 for a host of a host, and so on. */
  depth: number;
  /** The tag in the dependent's template that pulls the child in. */
  tag: string;
  file: string;
  line: number;
}

export interface ImpactUpResult {
  target: string;
  kind: UnitKind | "element";
  file: string | null;
  /** Element targets: the unit whose template owns the element. */
  owner: string | null;
  dependents: ImpactUpDependent[];
}

/**
 * Walk the `includes` edges backwards: which units pull this target in, and
 * which units pull those in. This is the caller side of `impact`.
 */
export function computeImpactUp(graph: Graph, rawTarget: string): ImpactUpResult {
  const target = findImpactTarget(graph, rawTarget);
  const units = new Map<string, UnitNode>();
  for (const node of graph.nodes) {
    if (isUnit(node)) units.set(node.id, node);
  }

  const result: ImpactUpResult = {
    target: target.id,
    kind: target.kind,
    file: target.file,
    owner: null,
    dependents: [],
  };

  let start: string | null;
  if (target.kind === "element") {
    const element = graph.nodes.find(
      (node): node is ElementNode => node.kind === "element" && node.id === target.id,
    );
    start = element?.host ?? null;
    result.owner = start;
  } else {
    start = target.id;
  }
  if (start === null) return result;

  const includedBy = new Map<string, IncludesEdge[]>();
  for (const edge of graph.edges) {
    if (edge.rel !== "includes") continue;
    const list = includedBy.get(edge.to);
    if (list === undefined) includedBy.set(edge.to, [edge]);
    else list.push(edge);
  }

  const visited = new Set<string>([start]);
  let frontier = [start];
  let depth = 1;
  while (frontier.length > 0 && depth <= 16) {
    const next: string[] = [];
    for (const id of [...frontier].sort()) {
      for (const edge of includedBy.get(id) ?? []) {
        if (visited.has(edge.from)) continue;
        visited.add(edge.from);
        const unit = units.get(edge.from);
        if (unit === undefined) continue;
        result.dependents.push({
          id: edge.from,
          kind: unit.kind,
          depth,
          tag: edge.tag,
          file: edge.file,
          line: edge.line,
        });
        next.push(edge.from);
      }
    }
    frontier = next;
    depth += 1;
  }

  result.dependents.sort((left, right) =>
    left.depth !== right.depth ? left.depth - right.depth : left.id.localeCompare(right.id),
  );
  return result;
}

/** Render the caller walk as an indented tree. */
export function formatImpactUp(result: ImpactUpResult): string {
  const header =
    result.kind === "element"
      ? `${result.target}  (element)`
      : `${result.target}  (${result.kind})`;
  const lines = [header];
  if (result.owner !== null) lines.push(`owned by  ${result.owner}`);
  lines.push("");

  if (result.dependents.length === 0) {
    lines.push("(no unit includes this target)");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const direct = result.dependents.filter((dependent) => dependent.depth === 1).length;
  const maxDepth = Math.max(...result.dependents.map((dependent) => dependent.depth));
  lines.push(
    `reached from ${result.dependents.length} unit(s): ` +
      `${direct} direct host(s), ${maxDepth} level(s) up`,
  );
  lines.push("");
  result.dependents.forEach((dependent, index) => {
    const indent = "  ".repeat(dependent.depth - 1);
    const lastAtDepth = result.dependents[index + 1]?.depth !== dependent.depth;
    lines.push(
      `${indent}${lastAtDepth ? "└─" : "├─"} ${dependent.id}  (${dependent.kind})  ` +
        `via <${dependent.tag}>  ${dependent.file}:${dependent.line}`,
    );
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatKeys(keys: string[] | null): string {
  if (keys === null) return "setData(patch)";
  return `setData({${keys.join(", ")}})`;
}

function formatSetData(rerender: ImpactRerender): string {
  const handler = rerender.handler === null ? "(outside a method)" : `in ${rerender.handler.name}`;
  return (
    `${formatKeys(rerender.keys)} ${handler}  ${rerender.file}:${rerender.line}  ` +
    `→  <${rerender.elementTag}>  ${rerender.elementFile}:${rerender.elementLine}  ` +
    `[via ${rerender.via}]`
  );
}

/** Render the impact answer as the tree a terminal or agent reads. */
export function formatImpact(result: ImpactResult): string {
  const lines: string[] = [];
  const header =
    result.kind === "element"
      ? `${result.target}  (element)`
      : `${result.target}  (${result.kind})`;
  lines.push(
    result.hosts.length > 0 ? `${header}  included by ${result.hosts.length} hosts` : header,
  );
  lines.push("");

  if (result.hosts.length > 0) {
    result.hosts.forEach((host, index) => {
      const lastHost = index === result.hosts.length - 1;
      const tagAttributes =
        host.passes.length === 0
          ? ""
          : ` ${host.passes.map((pass) => `${pass.attr}="{{${pass.expr}}}"`).join(" ")}`;
      lines.push(`${lastHost ? "└─" : "├─"} ${host.file}:${host.line}  <${host.tag}${tagAttributes}>`);

      const spine = lastHost ? " " : "│";
      for (const pass of host.passes) {
        lines.push(`${spine}    ← data ${pass.path}  (${host.host}.js)`);
      }

      const owned = result.rerenders.filter((rerender) => rerender.owner === host.host);
      owned.forEach((rerender, ownedIndex) => {
        const branch = ownedIndex === owned.length - 1 ? "└─" : "├─";
        lines.push(`${spine}    ${branch} ${formatSetData(rerender)}`);
      });
      if (owned.length === 0) lines.push(`${spine}    (no resolved re-render into this host)`);
    });

    // The target's own handlers can also re-render its elements; those hops
    // have no host to hang under.
    const hostIds = new Set(result.hosts.map((host) => host.host));
    const own = result.rerenders.filter((rerender) => !hostIds.has(rerender.owner));
    if (own.length > 0) {
      lines.push("");
      lines.push("own setData:");
      for (const rerender of own) lines.push(`├─ ${formatSetData(rerender)}`);
    }
  } else {
    for (const rerender of result.rerenders) {
      lines.push(`├─ ${formatSetData(rerender)}`);
    }
    if (result.rerenders.length === 0) lines.push("(no resolved rerenders edges)");
  }

  if (result.unresolvedHops.length > 0) {
    lines.push("");
    lines.push(`${result.unresolvedHops.length} unresolved hop(s):`);
    for (const hop of result.unresolvedHops) {
      const handler = hop.handler === null ? "" : ` in ${hop.handler}`;
      lines.push(
        `  ${hop.file}:${hop.line}${handler}  "${hop.key}"  ` +
          `no edge (${hop.status})  ${hop.detail}`,
      );
    }
  }

  if (result.unresolvedSetData.length > 0) {
    lines.push("");
    lines.push(`${result.unresolvedSetData.length} unresolved_setdata site(s):`);
    for (const site of result.unresolvedSetData) {
      const handler = site.handler === null ? "" : ` in ${site.handler}`;
      lines.push(`  ${site.file}:${site.line}${handler}  this.setData(<non-literal>)`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function attemptLine(attempt: RerenderAttempt): string {
  const label = attempt.key === null ? "(non-literal)" : `"${attempt.key}"`;
  const settled =
    attempt.status === "resolved"
      ? `resolved [${attempt.via ?? "?"}]  ${attempt.detail}`
      : `no edge (${attempt.status})  ${attempt.detail}`;
  return `  ${label}  ${settled}`;
}

function elementReference(graph: Graph, reference: string): ElementNode | null {
  return (
    graph.nodes.find(
      (node): node is ElementNode =>
        node.kind === "element" &&
        (node.id === reference || node.id === reference.replace(/^\.\//, "")),
    ) ?? null
  );
}

function callReference(graph: Graph, reference: string): SetDataNode | null {
  const calls = graph.nodes.filter(
    (node): node is SetDataNode => node.kind === "set_data",
  );
  return (
    calls.find((call) => call.id === reference) ??
    calls.find((call) => `${call.owner}.js:${call.line}` === reference) ??
    calls.find((call) => `${call.owner}:${call.line}` === reference) ??
    null
  );
}

/**
 * Print every hop behind one edge, including the hops that failed.
 *
 * Accepts a `set_data` node id, a `file:line` call site, or an element id.
 */
export function explain(
  graph: Graph,
  reference: string,
  resolution: Resolution = resolveGraph(graph),
): string {
  const value = reference.trim();
  const call = callReference(graph, value);
  const maps = buildMaps(graph);

  if (call !== null) {
    const handlerId = maps.callHandler.get(call.id);
    const handler = handlerId === undefined ? undefined : maps.handlers.get(handlerId);
    const lines = [
      `setData site  ${call.owner}.js:${call.line}  (owner ${call.owner})`,
      handler === undefined
        ? "handler  none (call outside a Page/Component method)"
        : `handler  ${handler.name}  ${handler.owner}.js:${handler.line}`,
      call.keys === null
        ? "keys     unknown (non-literal argument)"
        : `keys     ${call.keys.join(", ")}`,
      "",
    ];
    const attempts = resolution.attempts.filter((attempt) => attempt.call === call.id);
    if (attempts.length === 0) lines.push("  (no attempts recorded)");
    for (const attempt of attempts) lines.push(attemptLine(attempt));
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const element = elementReference(graph, value);
  if (element !== null) {
    const unit = resolution.units.get(element.host);
    const bindings = unit?.bindings.filter((binding) => binding.element === element.id) ?? [];
    const lines = [
      `element  <${element.tag}>  ${element.file}:${element.line}  (host ${element.host})`,
      "",
    ];
    if (bindings.length === 0) {
      lines.push("  (no bindings on this element)");
    } else {
      lines.push("bindings:");
      for (const binding of bindings) {
        lines.push(`  ${binding.attr}  ${binding.field}  ->  ${binding.path}  ${binding.file}:${binding.line}`);
      }
    }
    const incoming = resolution.attempts.filter(
      (attempt) => attempt.status === "resolved" && attempt.element === element.id,
    );
    lines.push("");
    if (incoming.length === 0) {
      lines.push("re-rendered by  none resolved");
    } else {
      lines.push("re-rendered by:");
      for (const attempt of incoming) {
        lines.push(`  ${attempt.file}:${attempt.line} [via ${attempt.via ?? "?"}]  ${attempt.detail}`);
      }
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  throw new Error(`no setData site or element matches "${value}"`);
}
