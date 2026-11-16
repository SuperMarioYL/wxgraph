import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

export interface ComponentDeclaration {
  tag: string;
  specifier: string;
  /** JSON file that declares the entry, project-relative. */
  file: string;
  /** 1-based line of the tag key. */
  line: number;
}

export interface SubpackageDecl {
  root: string;
  pages: string[];
  independent: boolean;
  /** 1-based line of the root value in app.json. */
  line: number;
}

export interface AppManifest {
  /** Main-package page ids, tabBar entries included. */
  pages: string[];
  tabBarPages: string[];
  subpackages: SubpackageDecl[];
  /** App-level `usingComponents`, applied to every page and component. */
  usingComponents: ComponentDeclaration[];
}

export interface FileManifest {
  /** Project-relative JSON path. */
  file: string;
  component: boolean;
  usingComponents: ComponentDeclaration[];
}

export interface ResolvedSpecifier {
  /** Unit id of the resolved component. */
  id: string;
  via: "project" | "miniprogram_npm" | "node_modules";
}

export type SpecifierResolution =
  | { ok: true; target: ResolvedSpecifier }
  | { ok: false; reason: string };

/** Convert an arbitrary path to the posix form used by every graph id. */
export function toPosix(file: string): string {
  return file.replace(/\\/g, "/");
}

/** Strip one of the mini-program unit extensions from a path. */
function stripUnitExtension(file: string): string {
  return file.replace(/\.(wxml|json|js|ts)$/, "");
}

/**
 * Normalise a page or component path into a unit id: posix separators, no
 * leading or trailing slash, no extension, no duplicate slashes.
 */
export function normalizeUnitPath(raw: string): string {
  let value = toPosix(raw).trim();
  value = stripUnitExtension(value);
  value = value.replace(/^\.\/+/, "");
  value = value.replace(/^\/+|\/+$/g, "");
  return value.replace(/\/{2,}/g, "/");
}

/** Unit id for a JSON manifest file. */
export function unitIdForManifest(file: string): string {
  return normalizeUnitPath(file);
}

/** 1-based line number of a character offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let index = 0; index < end; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function keyOffset(source: string, key: string, from = 0): number {
  return source.indexOf(JSON.stringify(key), from);
}

function entryLine(source: string, blockOffset: number, key: string): number {
  const offset = keyOffset(source, key, Math.max(blockOffset, 0));
  return lineAt(source, offset < 0 ? Math.max(blockOffset, 0) : offset);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readUsingComponents(
  record: Record<string, unknown>,
  file: string,
  source: string,
): ComponentDeclaration[] {
  const block = asRecord(record.usingComponents);
  if (block === null) return [];
  const blockOffset = keyOffset(source, "usingComponents");
  const declarations: ComponentDeclaration[] = [];
  for (const [tag, specifier] of Object.entries(block)) {
    if (typeof specifier !== "string" || specifier.trim() === "") continue;
    declarations.push({
      tag,
      specifier: specifier.trim(),
      file,
      line: entryLine(source, blockOffset, tag),
    });
  }
  return declarations;
}

function subpackagePageId(root: string, page: string): string {
  const pageId = normalizeUnitPath(page);
  if (pageId === "") return "";
  if (root === "" || pageId === root || pageId.startsWith(`${root}/`)) {
    return pageId;
  }
  return `${root}/${pageId}`;
}

export function parseAppManifest(source: string): AppManifest {
  const record = asRecord(JSON.parse(source));
  if (record === null) {
    throw new Error("app.json must contain a JSON object");
  }

  const pages = asStringArray(record.pages)
    .map(normalizeUnitPath)
    .filter((page) => page !== "");

  const tabBar = asRecord(record.tabBar);
  const tabBarPages = (Array.isArray(tabBar?.list) ? tabBar.list : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => (typeof entry.pagePath === "string" ? normalizeUnitPath(entry.pagePath) : ""))
    .filter((page) => page !== "");

  const seenPages = new Set(pages);
  for (const page of tabBarPages) {
    if (!seenPages.has(page)) {
      pages.push(page);
      seenPages.add(page);
    }
  }

  const subpackages: SubpackageDecl[] = [];
  const byRoot = new Map<string, SubpackageDecl>();
  for (const key of ["subpackages", "subPackages"]) {
    const raw = record[key];
    if (!Array.isArray(raw)) continue;
    const blockOffset = keyOffset(source, key);
    for (const entry of raw) {
      const item = asRecord(entry);
      if (item === null || typeof item.root !== "string") continue;
      const root = normalizeUnitPath(item.root);
      if (root === "") continue;
      const rootPages = asStringArray(item.pages)
        .map((page) => subpackagePageId(root, page))
        .filter((page) => page !== "");
      const existing = byRoot.get(root);
      if (existing !== undefined) {
        for (const page of rootPages) {
          if (!existing.pages.includes(page)) existing.pages.push(page);
        }
        if (item.independent === true) existing.independent = true;
        continue;
      }
      const declaration: SubpackageDecl = {
        root,
        pages: rootPages,
        independent: item.independent === true,
        line: entryLine(source, blockOffset, root),
      };
      byRoot.set(root, declaration);
      subpackages.push(declaration);
    }
  }

  return {
    pages,
    tabBarPages,
    subpackages,
    usingComponents: readUsingComponents(record, "app.json", source),
  };
}

export async function readAppManifest(projectDir: string): Promise<AppManifest> {
  let source: string;
  try {
    source = await readFile(path.join(projectDir, "app.json"), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read app.json: ${reason}`);
  }
  try {
    return parseAppManifest(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid app.json: ${reason}`);
  }
}

export function parseFileManifest(file: string, source: string): FileManifest {
  const record = asRecord(JSON.parse(source));
  if (record === null) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const normalized = toPosix(file);
  return {
    file: normalized,
    component: record.component === true,
    usingComponents: readUsingComponents(record, normalized, source),
  };
}

export async function readFileManifest(
  projectDir: string,
  file: string,
): Promise<FileManifest> {
  const source = await readFile(path.join(projectDir, file), "utf8");
  return parseFileManifest(toPosix(file), source);
}

const COMPONENT_SUFFIXES = [".json", ".wxml"];

function existingUnitBase(projectDir: string, base: string): boolean {
  const normalized = normalizeUnitPath(base);
  if (normalized === "" || normalized.startsWith("../")) return false;
  return COMPONENT_SUFFIXES.some((suffix) =>
    existsSync(path.join(projectDir, `${normalized}${suffix}`)),
  );
}

function packageParts(specifier: string): { pkg: string; subpath: string } {
  const parts = specifier.split("/").filter((part) => part !== "");
  const pkg = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? "");
  const subpath = specifier.startsWith("@")
    ? parts.slice(2).join("/")
    : parts.slice(1).join("/");
  return { pkg, subpath };
}

/**
 * Resolve a `usingComponents` value to a unit id.
 *
 * Three real forms are supported: root-absolute (`/component/x`), relative
 * (`../../components/x`) and npm specifiers (`@vant/weapp/button/index`,
 * `mp-html`). npm specifiers are looked up under `miniprogram_npm/<pkg>` and
 * then `node_modules/<pkg>`.
 */
export function resolveComponentSpecifier(
  projectDir: string,
  declaringFile: string,
  specifier: string,
): SpecifierResolution {
  const value = specifier.trim();
  if (value === "") {
    return { ok: false, reason: "empty specifier" };
  }
  if (value.startsWith("plugin://")) {
    return { ok: false, reason: "plugin components are out of scope" };
  }

  if (value.startsWith("/")) {
    const base = normalizeUnitPath(value);
    return existingUnitBase(projectDir, base)
      ? { ok: true, target: { id: base, via: "project" } }
      : { ok: false, reason: `no component found at project root path "${base}"` };
  }

  if (value.startsWith(".")) {
    const declaringDir = path.posix.dirname(toPosix(declaringFile));
    const joined = path.posix.normalize(path.posix.join(declaringDir, value));
    const base = normalizeUnitPath(joined);
    if (base === "" || base.startsWith("../")) {
      return { ok: false, reason: `relative specifier "${value}" escapes the project root` };
    }
    return existingUnitBase(projectDir, base)
      ? { ok: true, target: { id: base, via: "project" } }
      : { ok: false, reason: `no component found at relative path "${base}"` };
  }

  const { pkg, subpath } = packageParts(value);
  if (pkg === "") {
    return { ok: false, reason: `cannot determine a package name from "${value}"` };
  }

  for (const root of [`miniprogram_npm/${pkg}`, `node_modules/${pkg}`]) {
    const candidates = subpath === ""
      ? [`${root}/index`, root]
      : [`${root}/${subpath}`, `${root}/${subpath}/index`];
    for (const candidate of candidates) {
      if (existingUnitBase(projectDir, candidate)) {
        return {
          ok: true,
          target: {
            id: normalizeUnitPath(candidate),
            via: root.startsWith("miniprogram_npm") ? "miniprogram_npm" : "node_modules",
          },
        };
      }
    }
  }

  return {
    ok: false,
    reason: `package "${pkg}" is not present under miniprogram_npm/ or node_modules/`,
  };
}
