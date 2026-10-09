import path from "node:path";
import type { Ctx } from "../../../../collectors/context.js";
import { basename, getDocIndex } from "../../shared/docs-set.js";

export interface DocCandidate {
  path: string;
  lines: number;
  /** Tokens aproximados do documento (caracteres ÷ 4). */
  tokens: number;
  density: number;
  signal: "alto" | "médio" | "baixo";
  kind: "fluxo" | "análise" | "plano" | "guia" | "outro";
  /** Vale converter para o padrão de specs? */
  convertible: boolean;
  reason: string;
}

const CONVENTION = /^(readme|contributing|contributors|owners|changelog|license|code_of_conduct|security|pull_request_template|skill|claude|agents)(\.|$)/i;

/** Vocabulário que indica regra de negócio (pt/en). Conta ocorrências por mil caracteres. */
const RULE_WORDS =
  /\b(regras?|rules?|deve|devem|n[aã]o pode|nunca|sempre|obrigat[oó]ri\w+|threshold|limite|prazo|valida[cç]\w+|condi[cç][aã]o|c[aá]lculo|calcula\w*|f[oó]rmula|taxa|percentual|juros|provis\w+|vencid\w+|atraso|saldo|parcela\w*|apropria\w+|valor presente|perda|risco)\b/gi;
const IF_THEN = /\bse\b[^.\n]{0,60}\bent[aã]o\b/gi;
const FLOW = /```\s*(mermaid|flowchart)|flowchart\s+(TD|LR)|graph\s+(TD|LR)/gi;
const FORMULA = /^\s*[A-Za-zÀ-ÿ_]+[ᵢ\w]*\s*=\s*.+[\/*+\-^].+$/gm;

export function classifyDoc(rel: string, text: string): DocCandidate {
  const chars = Math.max(text.length, 1);
  const matches = (text.match(RULE_WORDS)?.length ?? 0) + (text.match(IF_THEN)?.length ?? 0) * 2 + (text.match(FLOW)?.length ?? 0) * 4 + (text.match(FORMULA)?.length ?? 0) * 2;
  const density = Math.round((matches / chars) * 10_000) / 10;
  const base = basename(rel);
  const lower = `${rel}\n${text.slice(0, 600)}`.toLowerCase();
  const kind: DocCandidate["kind"] = /fluxograma|flowchart|mermaid/.test(lower) ? "fluxo" : /an[aá]lise/.test(lower) ? "análise" : /plano|migra[cç]/.test(lower) ? "plano" : /readme|guia|implementation|instal|telemetry|opentelemetry|how/.test(lower) ? "guia" : "outro";
  const signal: DocCandidate["signal"] = density >= 12 ? "alto" : density >= 6 ? "médio" : "baixo";
  const lines = text.split(/\r?\n/).length;
  const tokens = Math.round(chars / 4);

  if (CONVENTION.test(base)) return { path: rel, lines, tokens, density, signal: "baixo", kind: "guia", convertible: false, reason: "documento de convenção (README, CONTRIBUTING…)" };
  if (kind === "guia") return { path: rel, lines, tokens, density, signal, kind, convertible: false, reason: "guia técnico/operacional, não descreve regra de negócio" };
  if (signal === "baixo") return { path: rel, lines, tokens, density, signal, kind, convertible: false, reason: "pouco vocabulário de regra de negócio" };
  return { path: rel, lines, tokens, density, signal, kind, convertible: true, reason: `${signal === "alto" ? "muito" : "algum"} vocabulário de regra (${density}/10 mil caracteres)${kind === "fluxo" ? ", fluxo de processo" : ""}` };
}

/** Documentos existentes avaliados como fonte para as specs (só os de negócio entram na conversão). */
export function inventoryDocs(ctx: Ctx): DocCandidate[] {
  const idx = getDocIndex(ctx);
  return idx.docs
    .filter((d) => !/^docs\/specs\//.test(d.rel) && !/(^|\/)\.claude\/|(^|\/)\.github\/skills\//.test(d.rel))
    .map((d) => classifyDoc(d.rel, d.text))
    .sort((a, b) => Number(b.convertible) - Number(a.convertible) || b.density - a.density);
}

export const docApp = (rel: string): string | null => /^apps\/[^/]+/.exec(rel)?.[0] ?? null;
export const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

export const stem = (rel: string) => path.posix.basename(rel).replace(/\.[^.]+$/, "");
