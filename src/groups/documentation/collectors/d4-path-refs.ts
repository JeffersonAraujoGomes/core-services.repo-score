import type { Evidence } from "../../../schema/evidence.js";
import { capEvidence, jobEvidence, measured, notApplicable, round, type Collector } from "../../../collectors/context.js";
import { getDocIndex, type Ref } from "../shared/docs-set.js";

export interface BrokenRef extends Ref {
  doc: string;
}

export function brokenRefs(ctx: Parameters<Collector["run"]>[0]): { total: number; broken: BrokenRef[] } {
  const idx = getDocIndex(ctx);
  let total = 0;
  const broken: BrokenRef[] = [];
  for (const [doc, refs] of idx.refs) {
    for (const r of refs) {
      total += 1;
      if (r.resolved === null) broken.push({ ...r, doc });
    }
  }
  return { total, broken };
}

export const d4PathRefs: Collector = {
  ids: ["D4"],
  async run(ctx) {
    const { total, broken } = brokenRefs(ctx);
    if (total === 0) return [notApplicable("D4", "nenhum documento com referência a caminhos de arquivo")];
    const evidence: Evidence[] = broken.map((b) => ({
      kind: "file" as const,
      path: b.doc,
      line: b.line,
      snippet: b.raw,
      note: `${b.kind === "arquivo" ? "citação Arquivo:" : b.kind === "link" ? "link" : "caminho"} não resolve`,
    }));
    if (evidence.length === 0) evidence.push(jobEvidence("d4-path-refs", `${total} referências de caminho em ${getDocIndex(ctx).docs.length} documentos, todas válidas`));
    return [measured("D4", round(((total - broken.length) / total) * 100, 2), capEvidence(evidence))];
  },
};
