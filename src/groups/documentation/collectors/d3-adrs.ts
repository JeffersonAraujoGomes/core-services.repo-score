import { statSync } from "node:fs";
import path from "node:path";
import { jobEvidence, measured, type Collector } from "../../../collectors/context.js";

const ADR_DIR = /(^|\/)(adrs?|decisions?)\/[^/]+\.(md|markdown|adoc|txt)$/i;
const ADR_NAME = /(^|\/)adr[-_ ]?\d+[^/]*\.(md|markdown|adoc)$/i;

export function adrFiles(files: string[], extraDirs: string[] = []): string[] {
  const extra = extraDirs.map((d) => d.replace(/\/+$/, "") + "/");
  return files.filter(
    (f) =>
      (ADR_DIR.test(f) || ADR_NAME.test(f) || extra.some((d) => f.startsWith(d) && /\.(md|markdown|adoc)$/i.test(f))) &&
      !/readme|template|index/i.test(path.posix.basename(f)),
  );
}

export const d3Adrs: Collector = {
  ids: ["D3"],
  async run(ctx) {
    const adrs = adrFiles(ctx.files, ctx.policy.docs.adr_dirs);
    if (adrs.length === 0) {
      return [measured("D3", "absent", [jobEvidence("d3-adrs", "nenhum ADR encontrado (adr/, adrs/, decisions/ ou ADR-NNN.md)")])];
    }
    const out = ctx.git(["log", "-1", "--format=%cI", "--", ...adrs]);
    let last: Date | null = out && out.trim() ? new Date(out.trim()) : null;
    if (!last || Number.isNaN(last.getTime())) last = null;
    // ADR criado ou alterado e ainda sem commit (a skill não commita; o commit é do usuário): vale a data do arquivo
    const uncommitted = (ctx.git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...adrs]) ?? "").split("\0").filter((l) => l.length > 3 && !l.startsWith(" D") && !l.startsWith("D ")).map((l) => l.slice(3));
    for (const f of uncommitted) {
      try {
        const m = statSync(path.join(ctx.root, f)).mtime;
        if (!last || m > last) last = m;
      } catch {
        /* arquivo sumiu entre a listagem e a leitura */
      }
    }
    const sample = adrs[adrs.length - 1]!;
    if (!last) {
      return [measured("D3", "present", [{ kind: "file", path: sample, line: 1, note: `${adrs.length} ADRs; data de atualização desconhecida (sem histórico git)` }], "medium")];
    }
    const ageDays = (ctx.now.getTime() - last.getTime()) / 86_400_000;
    return [
      measured("D3", ageDays <= 365 ? "recent" : "present", [
        { kind: "file", path: sample, line: 1, note: `${adrs.length} ADRs; última atualização há ${Math.round(ageDays)} dias` },
      ]),
    ];
  },
};
