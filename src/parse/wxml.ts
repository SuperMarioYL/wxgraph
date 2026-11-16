import type {
  BindsEdge,
  ContainsEdge,
  ElementNode,
  ForScope,
  HandlesEdge,
} from "../graph/schema";

export interface WxmlContext {
  /** Project-relative template path. */
  file: string;
  /** Unit id of the page or component that owns the template. */
  host: string;
}

export interface ParsedWxml {
  elements: ElementNode[];
  contains: ContainsEdge[];
  binds: BindsEdge[];
  handles: HandlesEdge[];
}

interface RawAttribute {
  name: string;
  value: string;
  /** Offset of the first character of the value (after the quote). */
  valueOffset: number;
  line: number;
}

interface StackEntry {
  tag: string;
  id: string;
}

const TAG_NAME = /[A-Za-z0-9_:.-]/;
const ATTRIBUTE_STOP = /[\s=/>]/;
// Native components that are written without a closing tag in real templates.
const VOID_TAGS = new Set([
  "image",
  "input",
  "icon",
  "progress",
  "slider",
  "switch",
  "checkbox",
  "radio",
  "textarea",
  "import",
  "include",
]);
// Template directives that do not render a node.
const NON_RENDERED_TAGS = new Set(["import", "include", "wxs"]);

const HANDLER_MODIFIERS = [
  "capture-bind",
  "capture-catch",
  "mut-bind",
  "bind",
  "catch",
] as const;

/**
 * Parse a handler attribute name into its event and modifier.
 *
 * Both spellings real templates mix are accepted: the concatenated shorthand
 * (`bindtap`, `catchtap`) and the colon form (`bind:tap`, `catch:tap`,
 * `capture-bind:tap`, `capture-catch:tap`, `mut-bind:tap`).
 */
export function parseHandlerAttribute(
  name: string,
): { event: string; modifier: string } | null {
  for (const modifier of HANDLER_MODIFIERS) {
    const colonPrefix = `${modifier}:`;
    if (name.startsWith(colonPrefix)) {
      const event = name.slice(colonPrefix.length);
      if (isEventName(event)) return { event, modifier };
      return null;
    }
    if (name.startsWith(modifier)) {
      const event = name.slice(modifier.length);
      if (isEventName(event)) return { event, modifier };
    }
  }
  return null;
}

function isEventName(event: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(event);
}

const EXPRESSION_KEYWORDS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "void",
  "delete",
]);

const EXPRESSION_GLOBALS = new Set([
  "Math",
  "Date",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "parseInt",
  "parseFloat",
  "isNaN",
  "NaN",
  "Infinity",
]);

function skipString(expression: string, start: number): number {
  const quote = expression[start];
  let index = start + 1;
  while (index < expression.length) {
    if (expression[index] === "\\") {
      index += 2;
      continue;
    }
    if (expression[index] === quote) return index + 1;
    index += 1;
  }
  return index;
}

function findClosing(expression: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let index = open;
  while (index < expression.length) {
    const char = expression[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(expression, index);
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * Extract the data paths read by a WXML expression.
 *
 * This is deliberately not an evaluator: arithmetic, comparisons and ternaries
 * are walked for identifiers, method calls are discarded, and dynamic bracket
 * access is collapsed to `[]` (`items[i].name` -> `items[].name`).
 */
export function extractDataPaths(expression: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    if (!seen.has(value)) {
      seen.add(value);
      paths.push(value);
    }
  };

  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(expression, index);
      continue;
    }
    if (!/[A-Za-z_$]/.test(char)) {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < expression.length && /[\w$]/.test(expression[index])) index += 1;
    let dataPath = expression.slice(start, index);
    let cancelled = false;

    // A bare call (`format(x)`) is not a data path; keep scanning its argument.
    if (expression[index] === "(") {
      cancelled = true;
    }

    while (!cancelled) {
      if (expression[index] === "." && /[A-Za-z_$]/.test(expression[index + 1] ?? "")) {
        const segmentStart = index + 1;
        let cursor = segmentStart + 1;
        while (cursor < expression.length && /[\w$]/.test(expression[cursor])) cursor += 1;
        dataPath += `.${expression.slice(segmentStart, cursor)}`;
        index = cursor;
        if (expression[index] === "(") {
          cancelled = true;
        }
        continue;
      }
      if (expression[index] === "[") {
        const close = findClosing(expression, index, "[", "]");
        if (close < 0) break;
        const inner = expression.slice(index + 1, close).trim();
        if (
          (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) ||
          (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
        ) {
          dataPath += `.${inner.slice(1, -1)}`;
        } else if (/^\d+$/.test(inner)) {
          dataPath += `[${inner}]`;
        } else {
          dataPath += "[]";
        }
        index = close + 1;
        continue;
      }
      break;
    }

    const rootName = dataPath.split(/[.[]/, 1)[0];
    if (
      !cancelled &&
      !EXPRESSION_KEYWORDS.has(rootName) &&
      !EXPRESSION_GLOBALS.has(rootName)
    ) {
      add(dataPath);
    }
  }

  return paths;
}

function stripBraces(value: string): string {
  const trimmed = value.trim();
  const match = /^\{\{([\s\S]*)\}\}$/.exec(trimmed);
  return (match === null ? trimmed : match[1]).trim();
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

function attributeValue(attributes: RawAttribute[], name: string): RawAttribute | undefined {
  return attributes.find((attribute) => attribute.name === name);
}

export function parseWxml(source: string, context: WxmlContext): ParsedWxml {
  const file = context.file.replace(/\\/g, "/");
  const lineOf = lineFinder(source);
  const elements: ElementNode[] = [];
  const contains: ContainsEdge[] = [];
  const binds: BindsEdge[] = [];
  const handles: HandlesEdge[] = [];
  const stack: StackEntry[] = [];
  const idCounts = new Map<string, number>();

  const elementId = (line: number, tag: string): string => {
    const base = `${file}:${line}:${tag}`;
    const count = (idCounts.get(base) ?? 0) + 1;
    idCounts.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  };

  const parentId = (): string =>
    stack.length === 0 ? context.host : stack[stack.length - 1].id;

  const emitBindings = (
    element: string,
    attribute: string,
    value: string,
    valueOffset: number,
  ): void => {
    const pattern = /\{\{([\s\S]*?)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const expression = match[1].trim();
      if (expression === "") continue;
      const line = lineOf(valueOffset + match.index);
      for (const field of extractDataPaths(expression)) {
        binds.push({
          rel: "binds",
          element,
          attr: attribute,
          field,
          expr: expression,
          file,
          line,
        });
      }
    }
  };

  const emitHandler = (element: string, attribute: RawAttribute): void => {
    const parsed = parseHandlerAttribute(attribute.name);
    if (parsed === null) return;
    const handler = attribute.value.trim();
    if (handler === "" || handler.includes("{{")) return;
    handles.push({
      rel: "handles",
      element,
      handler,
      event: parsed.event,
      modifier: parsed.modifier,
      file,
      line: attribute.line,
    });
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === "<") {
      if (source.startsWith("<!--", index)) {
        const end = source.indexOf("-->", index + 4);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", index)) {
        const end = source.indexOf("]]>", index + 9);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith("<?", index)) {
        const end = source.indexOf("?>", index + 2);
        index = end < 0 ? source.length : end + 2;
        continue;
      }
      if (source.startsWith("<!", index)) {
        const end = source.indexOf(">", index + 2);
        index = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith("</", index)) {
        const end = source.indexOf(">", index + 2);
        if (end < 0) break;
        const closeTag = source.slice(index + 2, end).trim().split(/\s+/)[0] ?? "";
        for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
          if (stack[depth].tag === closeTag) {
            stack.length = depth;
            break;
          }
        }
        index = end + 1;
        continue;
      }

      const tagResult = parseTag(source, index, lineOf);
      if (tagResult === null) {
        index += 1;
        continue;
      }
      index = tagResult.end;

      if (NON_RENDERED_TAGS.has(tagResult.tag)) {
        // `<wxs>` bodies contain JavaScript that may include `<`.
        if (tagResult.tag === "wxs" && !tagResult.selfClosing) {
          const close = source.indexOf("</wxs", index);
          if (close < 0) {
            index = source.length;
          } else {
            const end = source.indexOf(">", close);
            index = end < 0 ? source.length : end + 1;
          }
        }
        continue;
      }

      const line = lineOf(tagResult.offset);
      const id = elementId(line, tagResult.tag);
      const element: ElementNode = {
        kind: "element",
        id,
        file,
        line,
        tag: tagResult.tag,
        host: context.host,
      };

      const forAttribute = attributeValue(tagResult.attributes, "wx:for");
      if (forAttribute !== undefined) {
        const scope: ForScope = {
          source: stripBraces(forAttribute.value),
          item: stripBraces(attributeValue(tagResult.attributes, "wx:for-item")?.value ?? "") || "item",
          index:
            stripBraces(attributeValue(tagResult.attributes, "wx:for-index")?.value ?? "") || "index",
          key: attributeValue(tagResult.attributes, "wx:key")?.value.trim() ?? null,
        };
        element.for = scope;
      }

      const ifAttribute = attributeValue(tagResult.attributes, "wx:if");
      if (ifAttribute !== undefined) {
        element.if = stripBraces(ifAttribute.value);
      }

      const slotAttribute = attributeValue(tagResult.attributes, "slot");
      if (slotAttribute !== undefined && slotAttribute.value.trim() !== "") {
        element.slot = slotAttribute.value.trim();
      }

      if (tagResult.tag === "slot") {
        const nameAttribute = attributeValue(tagResult.attributes, "name");
        if (nameAttribute !== undefined && nameAttribute.value.trim() !== "") {
          element.slotName = nameAttribute.value.trim();
        }
      }

      elements.push(element);
      contains.push({
        rel: "contains",
        from: parentId(),
        to: id,
        file,
        line,
      });

      for (const attribute of tagResult.attributes) {
        emitHandler(id, attribute);
        emitBindings(id, attribute.name, attribute.value, attribute.valueOffset);
      }

      if (!tagResult.selfClosing && !VOID_TAGS.has(tagResult.tag)) {
        stack.push({ tag: tagResult.tag, id });
      }
      continue;
    }

    if (char === "{" && source[index + 1] === "{") {
      const end = source.indexOf("}}", index + 2);
      if (end < 0) break;
      const expression = source.slice(index + 2, end).trim();
      if (expression !== "" && stack.length > 0) {
        const line = lineOf(index);
        for (const field of extractDataPaths(expression)) {
          binds.push({
            rel: "binds",
            element: stack[stack.length - 1].id,
            attr: "#text",
            field,
            expr: expression,
            file,
            line,
          });
        }
      }
      index = end + 2;
      continue;
    }

    index += 1;
  }

  return { elements, contains, binds, handles };
}

interface ParsedTag {
  tag: string;
  attributes: RawAttribute[];
  selfClosing: boolean;
  /** Offset of the `<`. */
  offset: number;
  /** Offset just past the closing `>`. */
  end: number;
}

function parseTag(
  source: string,
  start: number,
  lineOf: (offset: number) => number,
): ParsedTag | null {
  let index = start + 1;
  const nameStart = index;
  while (index < source.length && TAG_NAME.test(source[index])) index += 1;
  const tag = source.slice(nameStart, index);
  if (tag === "" || !/[A-Za-z]/.test(tag[0])) return null;

  const attributes: RawAttribute[] = [];
  let selfClosing = false;

  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;
    if (source[index] === ">") {
      index += 1;
      break;
    }
    if (source[index] === "/" && source[index + 1] === ">") {
      selfClosing = true;
      index += 2;
      break;
    }

    const attributeStart = index;
    while (index < source.length && !ATTRIBUTE_STOP.test(source[index])) index += 1;
    const name = source.slice(attributeStart, index);
    if (name === "") {
      index += 1;
      continue;
    }

    while (index < source.length && /\s/.test(source[index])) index += 1;
    let value = "";
    let valueOffset = index;
    if (source[index] === "=") {
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        valueOffset = index;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        valueOffset = index;
        const valueStart = index;
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }

    attributes.push({
      name,
      value,
      valueOffset,
      line: lineOf(attributeStart),
    });
  }

  return { tag, attributes, selfClosing, offset: start, end: index };
}
