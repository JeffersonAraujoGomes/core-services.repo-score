import type { Evidence } from "../../../schema/evidence.js";
import { capEvidence, jobEvidence, measured, type Collector, type Ctx } from "../../../collectors/context.js";
import { basename, getDocIndex } from "../shared/docs-set.js";

const JUNK_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(bak|orig|rej|tmp|swp)$|~$/i;
// TODO/TBD só em caixa-alta: "todo" é uma palavra comum em português.
const PLACEHOLDER_MARKER = /\b(TODO|TBD|FIXME)\b/;
const PLACEHOLDER_PHRASE = /\blorem ipsum\b|\bcoloque aqui\b|\bpreencha (aqui|antes|com)\b|\ba preencher\b/i;
export const hasPlaceholder = (text: string) => PLACEHOLDER_MARKER.test(text) || PLACEHOLDER_PHRASE.test(text);
const LOOSE_NAME = /^(prompt|notas?|rascunho|draft|scratch|tmp|temp|old|backup|copia|copy)[_\-. ]/i;

export type ResidueKind = "arquivo residual" | "relatório efêmero versionado" | "documento vazio" | "marcador de pendência" | "documento solto";

export interface Residue {
  path: string;
  kind: ResidueKind;
  /** Pode ser removido automaticamente (arquivo lixo ou relatório efêmero); o resto exige decisão humana. */
  autoRemovable: boolean;
}

export function findResidues(ctx: Ctx): Residue[] {
  const out: Residue[] = [];
  const extra = ctx.policy.docs.residual_patterns.map((p) => new RegExp(p, "i"));
  const seen = new Set<string>();
  const add = (r: Residue) => {
    if (!seen.has(r.path)) {
      seen.add(r.path);
      out.push(r);
    }
  };
  for (const f of ctx.files) {
    if (JUNK_FILE.test(f) || extra.some((re) => re.test(f))) add({ path: f, kind: "arquivo residual", autoRemovable: true });
    else if (/(^|\/)\.impact-reports\//.test(f)) add({ path: f, kind: "relatório efêmero versionado", autoRemovable: true });
  }
  const idx = getDocIndex(ctx);
  const rootLevel = (rel: string) => !rel.includes("/");
  for (const d of idx.docs) {
    if (d.text.replace(/\s+/g, "").length < 20) add({ path: d.rel, kind: "documento vazio", autoRemovable: false });
    else if (hasPlaceholder(d.text)) add({ path: d.rel, kind: "marcador de pendência", autoRemovable: false });
    if (LOOSE_NAME.test(basename(d.rel)) && (rootLevel(d.rel) || /^docs?\//.test(d.rel))) add({ path: d.rel, kind: "documento solto", autoRemovable: false });
  }
  return out;
}

export const d8Hygiene: Collector = {
  ids: ["D8"],
  async run(ctx) {
    const residues = findResidues(ctx);
    const evidence: Evidence[] = residues.map((r) => ({ kind: "file" as const, path: r.path, line: 1, note: r.kind }));
    if (evidence.length === 0) evidence.push(jobEvidence("d8-hygiene", `${ctx.files.length} arquivos verificados, nenhum resíduo`));
    return [measured("D8", residues.length, capEvidence(evidence))];
  },
};

