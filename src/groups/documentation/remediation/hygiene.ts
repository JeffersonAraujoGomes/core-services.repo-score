import type { Ctx } from "../../../collectors/context.js";
import { readForEdit, upsert } from "../../../remediation/changes.js";
import type { ActionPlan, FileChange } from "../../../remediation/types.js";
import { findResidues } from "../collectors/d8-hygiene.js";

const IGNORE_FOR: { test: RegExp; line: string }[] = [
  { test: /(^|\/)\.DS_Store$/, line: ".DS_Store" },
  { test: /\.bak$/i, line: "*.bak" },
  { test: /\.orig$/i, line: "*.orig" },
  { test: /\.swp$/i, line: "*.swp" },
];

/** Remove só o que é lixo inequívoco (resíduos e relatórios efêmeros). Docs vazios, pendências e docs soltos viram aviso. */
export function planHygiene(ctx: Ctx): ActionPlan | null {
  const residues = findResidues(ctx);
  const removable = residues.filter((r) => r.autoRemovable);
  const manual = residues.filter((r) => !r.autoRemovable);
  const changes: FileChange[] = removable.map((r) => ({ op: "delete", path: r.path, note: r.kind }));

  const notes: string[] = [];
  const gi = readForEdit(ctx, ".gitignore", notes);
  const current = gi.skip ? "" : (gi.text ?? "");
  const missing = gi.skip ? [] : IGNORE_FOR.filter((i) => removable.some((r) => i.test.test(r.path)) && !current.split(/\r?\n/).includes(i.line)).map((i) => i.line);
  if (missing.length) {
    const sep = current !== "" && !current.endsWith("\n") ? "\n" : "";
    const c = upsert(ctx, ".gitignore", `${current}${sep}\n# repo-score: arquivos residuais\n${missing.join("\n")}\n`, { note: "evita que os resíduos voltem" });
    if (c) changes.push(c);
  }

  notes.push(...manual.slice(0, 15).map((r) => `Revisar manualmente: ${r.path} (${r.kind}).`));
  if (manual.length > 15) notes.push(`...e mais ${manual.length - 15} itens para revisão manual.`);
  if (changes.length === 0 && notes.length === 0) return null;
  return { changes, guided: [], notes, postSteps: [] };
}
