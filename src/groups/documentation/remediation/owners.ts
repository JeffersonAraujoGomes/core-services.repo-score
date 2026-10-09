import type { Ctx } from "../../../collectors/context.js";
import { readForEdit, upsert } from "../../../remediation/changes.js";
import type { ActionPlan, FileChange } from "../../../remediation/types.js";
import { ownersStatuses } from "../collectors/d2-owners.js";

const FIXABLE = new Set(["sem OWNERS.md", "OWNERS ainda tem o texto-modelo", "OWNERS sem mantenedores"]);

/** Gera OWNERS.md a partir do CODEOWNERS (donos já declarados e versionados); nunca inventa nomes. */
export function planOwners(ctx: Ctx): ActionPlan | null {
  const { statuses, co } = ownersStatuses(ctx);
  const changes: FileChange[] = [];
  const notes: string[] = [];
  if (statuses.every((s) => s.ok)) return null;
  if (!co) {
    return { changes: [], guided: [], notes: ["O repo não tem CODEOWNERS (.github/CODEOWNERS): crie um com os times responsáveis; o OWNERS.md é derivado dele."], postSteps: [] };
  }
  for (const s of statuses) {
    if (s.ok) continue;
    const label = s.app.dir || s.app.name;
    if (!FIXABLE.has(s.reason ?? "") || s.codeowners.length === 0) {
      notes.push(`${label}: ${s.reason}; ajuste manualmente.`);
      continue;
    }
    const file = s.file ?? (s.app.dir ? `${s.app.dir}/OWNERS.md` : "OWNERS.md");
    if (readForEdit(ctx, file, notes).skip) continue;
    const content = [
      "# Mantenedores",
      "",
      ...s.codeowners.map((o) => `- ${o}`),
      "",
      `<!-- Gerado pelo repo-score a partir do CODEOWNERS (${co.path}). Revise e acrescente as pessoas responsáveis. -->`,
      "",
    ].join("\n");
    const c = upsert(ctx, file, content, { note: `donos do CODEOWNERS para ${label}` });
    if (c) changes.push(c);
  }
  if (changes.length === 0 && notes.length === 0) return null;
  return { changes, guided: [], notes, postSteps: [] };
}
