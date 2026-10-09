import type { Evidence } from "../schema/evidence.js";
import { capEvidence, jobEvidence, measured, notApplicable, round, type Collector } from "./context.js";

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export interface ActionUse {
  line: number;
  uses: string;
  pinned: boolean;
  trusted: boolean;
}

/** `uses:` externos de um workflow. Locais (`./`) e `docker://` não entram. */
export function actionUses(text: string, trustedOrgs: string[]): ActionUse[] {
  const out: ActionUse[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const m = /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/.exec(line);
    if (!m) return;
    const uses = m[1] ?? "";
    if (uses.startsWith("./") || uses.startsWith("docker://")) return;
    const [name, ref = ""] = uses.split("@");
    const org = (name ?? "").split("/")[0] ?? "";
    out.push({
      line: idx + 1,
      uses,
      pinned: /^[0-9a-f]{40}$/.test(ref),
      trusted: trustedOrgs.includes(org),
    });
  });
  return out;
}

export const s13ActionsPinning: Collector = {
  ids: ["S13"],
  async run(ctx) {
    const workflows = ctx.files.filter((f) => WORKFLOW.test(f));
    if (workflows.length === 0) return [notApplicable("S13", "o repo não usa GitHub Actions (.github/workflows vazio)")];

    const evidence: Evidence[] = [];
    let total = 0;
    let ok = 0;
    for (const rel of workflows) {
      const text = ctx.readText(rel);
      if (text === null) continue;
      for (const u of actionUses(text, ctx.policy.trusted_action_orgs)) {
        total += 1;
        if (u.pinned || u.trusted) ok += 1;
        else evidence.push({ kind: "file", path: rel, line: u.line, snippet: u.uses, note: "tag ou branch, não SHA de 40 caracteres" });
      }
    }
    if (total === 0) {
      return [measured("S13", 100, [jobEvidence("s13-actions-pinning", `${workflows.length} workflows sem actions externas`)])];
    }
    const pct = round((ok / total) * 100, 1);
    return [
      measured(
        "S13",
        pct,
        evidence.length > 0
          ? capEvidence(evidence)
          : [jobEvidence("s13-actions-pinning", `${total} actions externas, todas fixadas por SHA ou de org confiável`)],
      ),
    ];
  },
};
