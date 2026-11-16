import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  extractDataPaths,
  parseHandlerAttribute,
  parseWxml,
} from "../src/parse/wxml";

const HOST = "pages/demo/index";

function template(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/templates/${name}`, import.meta.url)),
    "utf8",
  );
}

function parseFixture(name: string) {
  const file = `test/fixtures/templates/${name}`;
  return parseWxml(template(name), { file, host: HOST });
}

describe("handler attributes", () => {
  it("normalises every spelling to the same {event, modifier} pair", () => {
    const handlers = parseFixture("handlers.wxml");
    const byName = new Map(handlers.handles.map((edge) => [edge.handler, edge]));
    const shape = (name: string) => {
      const edge = byName.get(name);
      expect(edge, `missing handles edge for ${name}`).toBeDefined();
      return { event: edge?.event, modifier: edge?.modifier };
    };

    expect(shape("onBindShort")).toEqual({ event: "tap", modifier: "bind" });
    expect(shape("onBindColon")).toEqual(shape("onBindShort"));
    expect(shape("onCatchShort")).toEqual({ event: "tap", modifier: "catch" });
    expect(shape("onCatchColon")).toEqual(shape("onCatchShort"));
    expect(shape("onCaptureBind")).toEqual({ event: "tap", modifier: "capture-bind" });
    expect(shape("onCaptureBindShort")).toEqual(shape("onCaptureBind"));
    expect(shape("onCaptureCatch")).toEqual({ event: "tap", modifier: "capture-catch" });
    expect(shape("onCaptureCatchShort")).toEqual(shape("onCaptureCatch"));
    expect(shape("onMutBind")).toEqual({ event: "tap", modifier: "mut-bind" });
    expect(shape("onMutBindShort")).toEqual(shape("onMutBind"));
    expect(shape("onLongPress")).toEqual({ event: "longpress", modifier: "bind" });
  });

  it("keeps the attribute line and drops non-handler attributes", () => {
    const parsed = parseFixture("handlers.wxml");
    const colon = parsed.handles.find((edge) => edge.handler === "onBindColon");
    expect(colon).toMatchObject({
      rel: "handles",
      event: "tap",
      modifier: "bind",
      file: "test/fixtures/templates/handlers.wxml",
      line: 3,
    });
    expect(parseHandlerAttribute("data-bind")).toBeNull();
    expect(parseHandlerAttribute("bind")).toBeNull();
    expect(parseHandlerAttribute("bind:")).toBeNull();
  });
});

describe("wx:for scopes", () => {
  it("records nested aliases and keys on the element that declares them", () => {
    const parsed = parseFixture("nested-for.wxml");
    const outer = parsed.elements.find((element) => element.for?.item === "row");
    const inner = parsed.elements.find((element) => element.for?.item === "cell");

    expect(outer?.for).toEqual({
      source: "orders",
      item: "row",
      index: "i",
      key: "id",
    });
    expect(inner?.for).toEqual({
      source: "row.cells",
      item: "cell",
      index: "j",
      key: "*this",
    });
  });

  it("links the host, the outer loop and the inner loop by containment", () => {
    const parsed = parseFixture("nested-for.wxml");
    const file = "test/fixtures/templates/nested-for.wxml";
    const root = parsed.elements.find(
      (element) => element.tag === "view" && element.line === 1,
    );
    const outer = parsed.elements.find((element) => element.for?.item === "row");
    const inner = parsed.elements.find((element) => element.for?.item === "cell");

    expect(root).toBeDefined();
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(parsed.contains).toContainEqual({
      rel: "contains",
      from: HOST,
      to: root?.id,
      file,
      line: 1,
    });
    expect(parsed.contains).toContainEqual({
      rel: "contains",
      from: root?.id,
      to: outer?.id,
      file,
      line: 2,
    });
    expect(parsed.contains).toContainEqual({
      rel: "contains",
      from: outer?.id,
      to: inner?.id,
      file,
      line: 4,
    });
    expect(parsed.binds).toContainEqual({
      rel: "binds",
      element: outer?.id,
      attr: "wx:for",
      field: "orders",
      expr: "orders",
      file,
      line: 2,
    });
  });
});

describe("named slots", () => {
  it("records slot definitions and unnamed fallbacks", () => {
    const parsed = parseFixture("slots.wxml");
    const slots = parsed.elements.filter((element) => element.tag === "slot");
    expect(slots.map((element) => element.slotName)).toEqual([
      "header",
      undefined,
      "footer",
    ]);
  });

  it("records slot assignments on projected content", () => {
    const parsed = parseFixture("slot-content.wxml");
    const header = parsed.elements.find((element) => element.slot === "header");
    const footer = parsed.elements.find((element) => element.slot === "footer");
    expect(header?.tag).toBe("view");
    expect(footer?.tag).toBe("text");
    expect(parsed.binds).toContainEqual({
      rel: "binds",
      element: header?.id,
      attr: "#text",
      field: "title",
      expr: "title",
      file: "test/fixtures/templates/slot-content.wxml",
      line: 2,
    });
  });
});

describe("bindings", () => {
  it("extracts data paths from attributes, text and wx:if", () => {
    const parsed = parseFixture("bindings.wxml");
    const fields = parsed.binds.map((edge) => `${edge.attr}:${edge.field}`);

    expect(fields).toEqual(
      expect.arrayContaining([
        "class:active",
        "#text:item.title",
        "#text:item.price",
        "wx:if:visible",
        "wx:if:hidden",
        "src:item.cover",
        "#text:items[].name",
      ]),
    );

    const conditional = parsed.elements.find((element) => element.if !== undefined);
    expect(conditional?.if).toBe("visible && !hidden");
  });

  it("does not treat method calls or literals as data paths", () => {
    expect(extractDataPaths("format(item.price)")).toEqual(["item.price"]);
    expect(extractDataPaths("item.unitPrice / 100")).toEqual(["item.unitPrice"]);
    expect(extractDataPaths("a && !b")).toEqual(["a", "b"]);
    expect(extractDataPaths("obj['k']")).toEqual(["obj.k"]);
    expect(extractDataPaths("true ? 'yes' : 'no'")).toEqual([]);
  });
});
