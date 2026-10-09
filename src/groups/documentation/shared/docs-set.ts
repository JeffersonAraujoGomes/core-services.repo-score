import path from "node:path";
import type { Ctx } from "../../../collectors/context.js";
import { globToRegex } from "../../../util/glob.js";

const DOC_EXT = /\.(md|markdown)$/i;
const IGNORED_DIR = /(^|\/)(\.impact-reports|node_modules|bin|obj|vendor|dist|build|target)(\/|$)/;

/** Extensões que contam como "caminho de arquivo" em referências entre crases. */
const PATH_EXT = new Set([
  "md", "cs", "csproj", "sln", "json", "yml", "yaml", "ts", "tsx", "js", "mjs", "go", "kt", "kts", "java", "py", "sql",
  "sh", "xml", "props", "targets", "tf", "html", "txt", "toml", "dsl", "puml", "mmd", "proto", "gradle", "http", "ps1",
]);

/** Arquivos descobertos por convenção (não por link): nunca são "órfãos". */
const ENTRY_POINT = /^(readme|owners|skill|claude|agents|contributing|changelog|license|code_of_conduct|security|pull_request_template)(\.|$)/i;

export interface DocFile {
  rel: string;
  text: string;
}

export type RefKind = "link" | "arquivo" | "code";

export interface Ref {
  kind: RefKind;
  /** Alvo como escrito no documento. */
  raw: string;
  /** Linha (1-based) onde aparece. */
  line: number;
  /** Caminho resolvido (arquivo ou pasta, relativo à raiz) ou null se não existe. */
  resolved: string | null;
}

export interface DocIndex {
  docs: DocFile[];
  fileSet: Set<string>;
  dirSet: Set<string>;
  refs: Map<string, Ref[]>;
}

export const basename = (rel: string) => path.posix.basename(rel);
export const dirname = (rel: string) => (path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));

export function isEntryPoint(rel: string): boolean {
  return ENTRY_POINT.test(basename(rel));
}

export function isDocPath(rel: string, ignoreGlobs: RegExp[]): boolean {
  if (!DOC_EXT.test(rel) || IGNORED_DIR.test(rel)) return false;
  if (/^\.github\//.test(rel) && !/^\.github\/skills\//.test(rel)) return false;
  return !ignoreGlobs.some((g) => g.test(rel));
}

/** Linhas do texto fora de blocos de código cercados (``` ou ~~~), com a numeração original. */
export function linesOutsideFences(text: string): { n: number; line: string }[] {
  const out: { n: number; line: string }[] = [];
  let fence: string | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (m) {
      const marker = m[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence === null) out.push({ n: i + 1, line });
  });
  return out;
}

function cleanTarget(raw: string): string | null {
  let t = raw.trim().replace(/^<|>$/g, "").replace(/[.,;:)]+$/, "");
  try {
    t = decodeURI(t);
  } catch {
    /* mantém como está */
  }
  t = t.replace(/[#?].*$/, "");
  if (t === "" || /^[a-z][a-z0-9+.-]*:/i.test(t) || /[*<>{}$|]|\.\.\./.test(t)) return null;
  return t;
}

const looksLikePath = (t: string) => {
  if (!t.includes("/")) return false;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(t)?.[1]?.toLowerCase();
  return !!ext && PATH_EXT.has(ext);
};

/** A citação `Arquivo: x` só vale se x parece um caminho; "Arquivo: caminho" e `caminho/do/arquivo.ext` são exemplos. */
const isExamplePath = (t: string) => !/[/.]/.test(t) || /^(caminho|path)\/(do|to)\//i.test(t);

export function extractRefs(text: string): Omit<Ref, "resolved">[] {
  const out: Omit<Ref, "resolved">[] = [];
  for (const { n, line } of linesOutsideFences(text)) {
    const seen = new Set<string>();
    const push = (kind: RefKind, raw: string) => {
      if (seen.has(raw)) return; // o mesmo alvo na mesma linha (ex.: link com o caminho entre crases) conta uma vez
      seen.add(raw);
      out.push({ kind, raw, line: n });
    };
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
      const t = cleanTarget(m[1] ?? "");
      if (t) push("link", t);
    }
    for (const m of line.matchAll(/\bArquivo:\s+`?([^`\s]+)/g)) {
      const t = cleanTarget(m[1] ?? "");
      if (t && !isExamplePath(t)) push("arquivo", t);
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const t = cleanTarget(m[1] ?? "");
      if (t && looksLikePath(t) && !/\s/.test(t) && !isExamplePath(t)) push("code", t);
    }
  }
  return out;
}

/** Resolve um alvo para um arquivo/pasta existente (relativo à raiz) ou null. */
export function resolveTarget(
  kind: RefKind,
  raw: string,
  fromDoc: string,
  fileSet: Set<string>,
  dirSet: Set<string>,
): string | null {
  const rootRel = raw.replace(/^\/+/, "").replace(/^\.\//, "");
  const docRel = path.posix.normalize(path.posix.join(dirname(fromDoc), raw));
  // Citações (Arquivo: e caminhos entre crases) podem ser relativas à raiz do repo, ao doc ou a qualquer pasta
  // acima dele (ex.: a raiz do app, em docs que vivem dentro de apps/<app>/). Links Markdown são só relativos ao doc.
  const ancestors: string[] = [];
  for (let d = dirname(fromDoc); d !== ""; d = dirname(d)) ancestors.push(path.posix.normalize(path.posix.join(d, rootRel)));
  const candidates =
    raw.startsWith("/") ? [rootRel] : kind === "link" ? [docRel] : [path.posix.normalize(rootRel), docRel, ...ancestors];
  for (const c of candidates) {
    const norm = c.replace(/\/+$/, "");
    if (norm.startsWith("..")) continue;
    if (fileSet.has(norm) || dirSet.has(norm)) return norm;
  }
  return null;
}

const cache = new WeakMap<Ctx, DocIndex>();

export function getDocIndex(ctx: Ctx): DocIndex {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const ignore = ctx.policy.docs.ignore_globs.map(globToRegex);
  const fileSet = new Set(ctx.files);
  const dirSet = new Set<string>();
  for (const f of ctx.files) {
    let d = dirname(f);
    while (d !== "" && !dirSet.has(d)) {
      dirSet.add(d);
      d = dirname(d);
    }
  }
  const docs: DocFile[] = [];
  for (const rel of ctx.files) {
    if (!isDocPath(rel, ignore)) continue;
    const text = ctx.readText(rel);
    if (text !== null) docs.push({ rel, text });
  }
  const refs = new Map<string, Ref[]>();
  for (const d of docs) {
    refs.set(
      d.rel,
      extractRefs(d.text).map((r) => ({ ...r, resolved: resolveTarget(r.kind, r.raw, d.rel, fileSet, dirSet) })),
    );
  }
  const index = { docs, fileSet, dirSet, refs };
  cache.set(ctx, index);
  return index;
}

/** Primeiro título H1 do documento, ou o nome do arquivo. */
export function docTitle(doc: DocFile): string {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(doc.text);
  return m?.[1]?.trim() || basename(doc.rel).replace(/\.(md|markdown)$/i, "");
}

export const MANAGED_START = "<!-- repo-score:docs-index -->";
export const MANAGED_END = "<!-- /repo-score:docs-index -->";

export function stripManagedBlock(text: string): string {
  return text.replace(new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}`), "");
}
