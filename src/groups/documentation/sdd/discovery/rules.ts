import path from "node:path";
import type { Ctx } from "../../../../collectors/context.js";
import { dirname } from "../../shared/docs-set.js";
import { classifyRuleFile, isRuleCandidate, isTestLike, methodsOf, type RuleFile } from "../../shared/rule-files.js";

export type { RuleFile };
export { methodsOf };

/** Arquivos de código que carregam regra de negócio (mesma definição do D7). Nada é lido por modelo. */
export function discoverRuleFiles(ctx: Ctx, scope: string | null = null): { rules: RuleFile[]; skippedPlumbing: number; skippedLow: number } {
  const prefix = scope ? `${scope}/` : "";
  let skippedPlumbing = 0;
  let skippedLow = 0;
  const rules: RuleFile[] = [];
  for (const f of ctx.files) {
    if (!f.startsWith(prefix) || !isRuleCandidate(f)) continue;
    const text = ctx.readText(f);
    if (text === null) continue;
    const v = classifyRuleFile(f, text);
    if (v.rule) rules.push(v.file);
    else if (v.why === "infraestrutura" || v.why === "gerado") skippedPlumbing += 1;
    else if (v.why === "baixa-densidade") skippedLow += 1;
  }
  return { rules: rules.sort((a, b) => b.density - a.density), skippedPlumbing, skippedLow };
}

/** Pastas de enums e constantes: matéria-prima do glossário e dos invariantes. */
export function discoverGlossaryFiles(ctx: Ctx): string[] {
  return ctx.files
    .filter((f) => /(^|\/)(Enums?|Constants?)\//i.test(f) && /\.(cs|java|kt|ts|go)$/.test(f) && !isTestLike(f))
    .sort((a, b) => (ctx.readText(b)?.length ?? 0) - (ctx.readText(a)?.length ?? 0));
}

/** Índice símbolo → arquivos, para ligar identificadores citados em documentos ao código que os define. */
export function symbolIndex(ctx: Ctx): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  const add = (sym: string, f: string) => index.set(sym, (index.get(sym) ?? new Set()).add(f));
  for (const f of ctx.files) {
    if (!isRuleCandidate(f)) continue;
    const text = ctx.readText(f);
    if (text === null) continue;
    add(path.posix.basename(f).replace(/\.[^.]+$/, ""), f);
    for (const m of text.matchAll(/\b(?:class|interface|record|struct|enum)\s+(\w{5,})/g)) add(m[1]!, f);
    for (const n of methodsOf(text)) if (n.length >= 6) add(n, f);
  }
  return new Map([...index].map(([k, v]) => [k, [...v]]));
}

export const dirOf = dirname;
