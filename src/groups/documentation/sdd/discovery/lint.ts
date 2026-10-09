import type { Ctx } from "../../../../collectors/context.js";
import { audienceFromName, audienceOfFiles } from "../audience.js";
import { lintSpec, type LintIssue } from "../spec-standard.js";

export interface SpecLintResult {
  path: string;
  lines: number;
  issues: LintIssue[];
  /** Ponteiros `Arquivo:` que não existem no repo. */
  missingPointers: string[];
}

/** Specs (documentos em <specsDir>, menos os índices) avaliadas contra o padrão e contra o repo. */
export function lintSpecs(ctx: Ctx, specsDir = "docs/specs"): SpecLintResult[] {
  const prefix = specsDir.replace(/\/+$/, "") + "/";
  const files = new Set(ctx.files);
  return ctx.files
    .filter((f) => f.startsWith(prefix) && /\.md$/i.test(f) && !/(^|\/)(readme|index)\.md$/i.test(f) && !f.includes("/.impact-reports/"))
    .map((rel) => {
      const text = ctx.readText(rel) ?? "";
      const tagged = audienceFromName(rel);
      // sem marcação no nome, a natureza vem dos arquivos que a spec cita (assim a linguagem também é conferida nas legadas)
      const pointed = [...text.matchAll(/Arquivo:\s+`?([^`\s]+)/g)].map((m) => m[1]!);
      const issues = lintSpec(text, undefined, { audience: tagged ?? audienceOfFiles(pointed) });
      if (!tagged) issues.push({ level: "warn", rule: "marcacao", message: "o nome do arquivo não traz a marcação BUS (regra de negócio) ou ENG (componente técnico), ex.: 03.25-BUS-tema.md" });
      const missingPointers = [...text.matchAll(/Arquivo:\s+`?([^`\s]+)/g)].map((m) => m[1]!.replace(/[.,;)]+$/, "")).filter((p) => !files.has(p) && !ctx.files.some((f) => f.endsWith("/" + p)));
      for (const p of missingPointers) issues.push({ level: "error", rule: "ponteiros", message: `ponteiro para arquivo que não existe: ${p}` });
      return { path: rel, lines: text.split("\n").filter((l) => l.trim() !== "").length, issues, missingPointers };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function formatLint(results: SpecLintResult[]): string {
  if (results.length === 0) return "Nenhuma spec encontrada em docs/specs (o SDD está ausente).";
  const bad = results.filter((r) => r.issues.some((i) => i.level === "error"));
  const warn = results.filter((r) => !bad.includes(r) && r.issues.length > 0);
  const L = [`Padrão das specs: ${results.length - bad.length - warn.length} conformes · ${warn.length} com avisos · ${bad.length} com erros (de ${results.length})`];
  for (const r of [...bad, ...warn].slice(0, 40)) {
    L.push(`  ${bad.includes(r) ? "✕" : "!"} ${r.path} (${r.lines} linhas)`);
    for (const i of r.issues.slice(0, 4)) L.push(`      ${i.level === "error" ? "erro " : "aviso"} [${i.rule}] ${i.message}`);
  }
  if (bad.length + warn.length > 40) L.push(`  … e mais ${bad.length + warn.length - 40} specs`);
  return L.join("\n");
}
