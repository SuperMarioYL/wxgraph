import { parse as parseAcorn } from "acorn";

import {
  handlerId,
  setDataId,
  type HandlerNode,
  type SetDataNode,
} from "../graph/schema";

export interface ScriptContext {
  /** Project-relative `.js` path. */
  file: string;
  /** Unit id of the page or component the file belongs to. */
  owner: string;
}

export interface SetDataSite {
  node: SetDataNode;
  /** null when the call sits outside any Page/Component method. */
  handler: HandlerNode | null;
}

export interface CloudCall {
  name: string;
  line: number;
  handler: HandlerNode | null;
}

export interface ParsedScript {
  /**
   * Which registration call the file used. null means no `Page({...})` /
   * `Component({...})` object literal was readable (for example
   * `Page(Object.assign(...))`), so this file's method set is unknown.
   */
  rootKind: "page" | "component" | null;
  handlers: HandlerNode[];
  setDataNodes: SetDataNode[];
  setDataSites: SetDataSite[];
  cloudCalls: CloudCall[];
  /** Literal top-level keys of a component's `properties`. */
  propertyNames: string[];
}

export type ScriptParseResult =
  | { ok: true; sourceType: "module" | "script"; script: ParsedScript }
  | { ok: false; error: string };

/** Minimal structural view of an ESTree node; acorn's own types stay private. */
interface EstreeNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function isNode(value: unknown): value is EstreeNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function childNodes(node: EstreeNode): EstreeNode[] {
  const children: EstreeNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) children.push(item);
      }
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

function walk(node: EstreeNode, visit: (node: EstreeNode) => void): void {
  visit(node);
  for (const child of childNodes(node)) walk(child, visit);
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineFinder(source: string): (offset: number) => number {
  const starts = computeLineStarts(source);
  return (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    const target = Math.max(0, Math.min(offset, source.length));
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (starts[mid] <= target) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function parseWith(source: string, sourceType: "module" | "script"): EstreeNode {
  return parseAcorn(source, {
    ecmaVersion: "latest",
    sourceType,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowHashBang: true,
  }) as unknown as EstreeNode;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/\s+/g, " ").trim();
  return String(error);
}

function isFunctionNode(node: EstreeNode | undefined): boolean {
  return (
    node !== undefined &&
    (node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionDeclaration")
  );
}

function stringValue(node: EstreeNode): string | null {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const expressions = node.expressions as unknown[];
    if (Array.isArray(expressions) && expressions.length !== 0) return null;
    const quasis = node.quasis as Array<{ value?: { cooked?: unknown } }>;
    const cooked = quasis[0]?.value?.cooked;
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
}

/**
 * Property name of an object-literal member. Computed keys are not literal
 * names and yield null.
 */
function propertyName(property: EstreeNode): string | null {
  if (property.type !== "Property" || property.computed === true) return null;
  const key = property.key;
  if (!isNode(key)) return null;
  if (key.type === "Identifier") return String(key.name);
  if (key.type === "Literal") {
    if (typeof key.value === "string") return key.value;
    if (typeof key.value === "number") return String(key.value);
  }
  return null;
}

function propertiesOf(object: EstreeNode): EstreeNode[] {
  if (object.type !== "ObjectExpression") return [];
  return (object.properties as EstreeNode[]).filter(isNode);
}

function findProperty(object: EstreeNode, name: string): EstreeNode | null {
  for (const property of propertiesOf(object)) {
    if (propertyName(property) === name) return property;
  }
  return null;
}

/**
 * Collect the literal paths of an object-literal argument: `{form: {name}}`
 * yields `form` and `form.name`.
 */
function collectObjectKeys(object: EstreeNode, prefix: string, out: string[]): void {
  for (const property of propertiesOf(object)) {
    const name = propertyName(property);
    if (name === null) continue;
    const path = prefix === "" ? name : `${prefix}.${name}`;
    out.push(path);
    const value = property.value;
    if (isNode(value) && value.type === "ObjectExpression") {
      collectObjectKeys(value, path, out);
    }
  }
}

function firstArgument(call: EstreeNode): EstreeNode | null {
  const args = call.arguments as EstreeNode[] | undefined;
  if (!Array.isArray(args) || args.length === 0) return null;
  return isNode(args[0]) ? args[0] : null;
}

function memberName(node: EstreeNode): string | null {
  if (node.type !== "MemberExpression" || node.computed === true) return null;
  const property = node.property;
  if (isNode(property) && property.type === "Identifier") return String(property.name);
  return null;
}

function isThisSetData(node: EstreeNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (!isNode(callee) || callee.type !== "MemberExpression") return false;
  if (!isNode(callee.object) || callee.object.type !== "ThisExpression") return false;
  return memberName(callee) === "setData";
}

/** `wx.cloud.callFunction(...)` */
function isCloudCallFunction(node: EstreeNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (!isNode(callee) || callee.type !== "MemberExpression") return false;
  if (memberName(callee) !== "callFunction") return false;
  const object = callee.object;
  if (!isNode(object) || object.type !== "MemberExpression") return false;
  const root = object.object;
  return (
    isNode(root) &&
    root.type === "Identifier" &&
    root.name === "wx" &&
    memberName(object) === "cloud"
  );
}

interface RootDefinition {
  kind: "page" | "component";
  object: EstreeNode;
}

function findRoot(program: EstreeNode): RootDefinition | null {
  let found: RootDefinition | null = null;
  walk(program, (node) => {
    if (found !== null || node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!isNode(callee) || callee.type !== "Identifier") return;
    if (callee.name !== "Page" && callee.name !== "Component") return;
    const argument = firstArgument(node);
    if (argument === null || argument.type !== "ObjectExpression") return;
    found = { kind: callee.name === "Page" ? "page" : "component", object: argument };
  });
  return found;
}

interface MethodEntry {
  name: string;
  node: EstreeNode;
}

function collectMethods(root: RootDefinition): MethodEntry[] {
  const methods: MethodEntry[] = [];
  const seen = new Set<string>();

  const add = (name: string | null, value: EstreeNode | undefined): void => {
    if (name === null || !isFunctionNode(value) || seen.has(name)) return;
    seen.add(name);
    methods.push({ name, node: value as EstreeNode });
  };

  for (const property of propertiesOf(root.object)) {
    const name = propertyName(property);
    if (name === null) continue;
    const value = property.value;
    if (isNode(value) && (name === "methods" || name === "lifetimes")) {
      for (const nested of propertiesOf(value)) {
        add(propertyName(nested), nested.value as EstreeNode | undefined);
      }
      continue;
    }
    add(name, value as EstreeNode | undefined);
  }
  return methods;
}

function propertyNamesOf(root: RootDefinition): string[] {
  const property = findProperty(root.object, "properties");
  const value = property?.value;
  if (!isNode(value)) return [];
  if (value.type !== "ObjectExpression") return [];
  const names: string[] = [];
  for (const member of propertiesOf(value)) {
    const name = propertyName(member);
    if (name !== null) names.push(name);
  }
  return names;
}

/**
 * Parse one `.js` file and extract the m2 facts.
 *
 * The file is parsed as an ES module first and retried as a classic script,
 * because mini-program pages are commonly modules while utility files are
 * commonly scripts (and vice versa). A file that fails both is reported as an
 * error, never silently dropped.
 */
export function parseScript(source: string, context: ScriptContext): ScriptParseResult {
  const lineOf = lineFinder(source);
  const file = context.file.replace(/\\/g, "/");
  const owner = context.owner;

  let program: EstreeNode | null = null;
  let sourceType: "module" | "script" = "module";
  let moduleError = "";
  try {
    program = parseWith(source, "module");
  } catch (error) {
    moduleError = errorMessage(error);
    try {
      program = parseWith(source, "script");
      sourceType = "script";
    } catch (scriptFailure) {
      return {
        ok: false,
        error:
          `cannot parse ${file} as an ES module or a script: ` +
          `module: ${moduleError}; script: ${errorMessage(scriptFailure)}`,
      };
    }
  }

  const root = findRoot(program);
  if (root === null) {
    // No Page()/Component(): not an error, but nothing is attached to the graph.
    return {
      ok: true,
      sourceType,
      script: {
        rootKind: null,
        handlers: [],
        setDataNodes: [],
        setDataSites: [],
        cloudCalls: [],
        propertyNames: [],
      },
    };
  }

  const methods = collectMethods(root);
  const methodRanges = methods.map((method) => ({
    name: method.name,
    line: lineOf(method.node.start),
    start: method.node.start,
    end: method.node.end,
  }));

  const handlerFor = (offset: number): HandlerNode | null => {
    let best: (typeof methodRanges)[number] | null = null;
    for (const range of methodRanges) {
      if (offset < range.start || offset > range.end) continue;
      if (best === null || range.end - range.start < best.end - best.start) best = range;
    }
    if (best === null) return null;
    return {
      kind: "handler",
      id: handlerId(owner, best.name),
      owner,
      name: best.name,
      line: best.line,
    };
  };

  const handlers: HandlerNode[] = methodRanges.map((range) => ({
    kind: "handler",
    id: handlerId(owner, range.name),
    owner,
    name: range.name,
    line: range.line,
  }));

  const setDataNodes: SetDataNode[] = [];
  const setDataSites: SetDataSite[] = [];
  const cloudCalls: CloudCall[] = [];
  const lineCounts = new Map<number, number>();

  walk(program, (node) => {
    if (isThisSetData(node)) {
      const line = lineOf(node.start);
      const ordinal = (lineCounts.get(line) ?? 0) + 1;
      lineCounts.set(line, ordinal);
      const argument = firstArgument(node);
      let keys: string[] | null = null;
      if (argument !== null && argument.type === "ObjectExpression") {
        keys = [];
        collectObjectKeys(argument, "", keys);
      }
      const setData: SetDataNode = {
        kind: "set_data",
        id: setDataId(owner, line, ordinal),
        owner,
        keys,
        line,
      };
      setDataNodes.push(setData);
      setDataSites.push({ node: setData, handler: handlerFor(node.start) });
      return;
    }
    if (isCloudCallFunction(node)) {
      const argument = firstArgument(node);
      const nameNode = argument !== null ? findProperty(argument, "name")?.value : undefined;
      if (!isNode(nameNode)) return;
      const name = stringValue(nameNode);
      if (name === null || name.trim() === "") return;
      cloudCalls.push({
        name: name.trim(),
        line: lineOf(node.start),
        handler: handlerFor(node.start),
      });
    }
  });

  return {
    ok: true,
    sourceType,
    script: {
      rootKind: root.kind,
      handlers,
      setDataNodes,
      setDataSites,
      cloudCalls,
      propertyNames: propertyNamesOf(root),
    },
  };
}
