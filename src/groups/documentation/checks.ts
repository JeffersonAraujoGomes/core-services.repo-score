import type { Ctx } from "../../collectors/context.js";
import { brokenRefs } from "./collectors/d4-path-refs.js";
import { refSuggester } from "./remediation/broken-refs.js";
import { dirname, getDocIndex } from "./shared/docs-set.js";
import path from "node:path";

export interface RefIssue {
  doc: string;
  line: number;
  raw: string;
  kind: string;
  /** Caminho completo sugerido quando só existe um arquivo com esse nome no repo; null caso contrário. */
  suggestion: string | null;
  candidates: number;
}

export interface RefCheck {
  /** `changed`: só os arquivos alterados ou novos; `all`: todos os documentos. */
  scope: "changed" | "all";
  scannedDocs: number;
  totalRefs: number;
  broken: RefIssue[];
}

/**
 * Confere, por script (0 tokens), se cada caminho, link e `Arquivo:` dos documentos resolve. É o que o D4 mede: roda
 * antes do `fix seal` para a falha aparecer no arquivo escrito, e não só como queda de nota depois.
 */
export function checkRefs(ctx: Ctx, opts: { files?: string[] } = {}): RefCheck {
  const only = opts.files ? new Set(opts.files) : null;
  const { broken } = brokenRefs(ctx);
  const suggest = refSuggester(ctx);
  const mine = broken.filter((b) => !only || only.has(b.doc));
  const issues = mine
    .map((b) => {
      const s = suggest(b);
      const suggestion = s.target === null ? null : b.kind === "link" ? path.posix.relative(dirname(b.doc), s.target) : s.target;
      return { doc: b.doc, line: b.line, raw: b.raw, kind: b.kind, suggestion, candidates: s.candidates };
    })
    .sort((a, b) => a.doc.localeCompare(b.doc) || a.line - b.line);
  const docs = ctx.files.filter((f) => /\.(md|markdown|mdx)$/i.test(f) && (!only || only.has(f)));
  let totalRefs = 0;
  for (const [doc, refs] of getDocIndex(ctx).refs) if (!only || only.has(doc)) totalRefs += refs.length;
  return { scope: only ? "changed" : "all", scannedDocs: docs.length, totalRefs, broken: issues };
}

export function formatRefCheck(r: RefCheck): string {
  const where = r.scope === "changed" ? "nos arquivos alterados ou novos" : "em todos os documentos";
  if (r.broken.length === 0) return `Caminhos OK ${where}: nenhuma referência quebrada (${r.totalRefs} referência(s) em ${r.scannedDocs} documento(s)).`;
  const L = [`${r.broken.length} referência(s) quebrada(s) ${where}. Corrija todas antes do fix seal (o D4 mede exatamente isto):`];
  for (const b of r.broken.slice(0, 60)) {
    const how = b.suggestion ? `use ${b.suggestion}` : b.candidates > 1 ? `${b.candidates} arquivos com esse nome: escolha o certo e escreva o caminho completo` : "não existe no repo: escreva como texto simples (sem crase nem link) ou aponte para um arquivo real";
    L.push(`  ✕ ${b.doc}:${b.line}  ${b.raw}  → ${how}`);
  }
  if (r.broken.length > 60) L.push(`  … e mais ${r.broken.length - 60}`);
  return L.join("\n");
}
