import type { Evidence } from "../../../schema/evidence.js";
import { capEvidence, jobEvidence, measured, notApplicable, round, type Collector, type Ctx } from "../../../collectors/context.js";
import { basename, dirname, extractRefs, getDocIndex, isEntryPoint, resolveTarget, stripManagedBlock, type DocIndex, type Ref } from "../shared/docs-set.js";

const ROOT_EXEMPT = /^(readme|license|changelog|code_of_conduct|security|contributing|owners|claude|agents|pull_request_template)(\.|$)/i;

const isIndexName = (rel: string) => /^(readme|index)\.md$/i.test(basename(rel));

/** Documentos de primeiro nível que o índice da raiz deveria listar. */
export function topLevelDocs(ctx: Ctx, idx: DocIndex): string[] {
  const roots = ctx.policy.docs.roots;
  const out = new Set<string>();
  for (const d of idx.docs) {
    const dir = dirname(d.rel);
    if (dir === "") {
      if (!ROOT_EXEMPT.test(basename(d.rel))) out.add(d.rel);
      continue;
    }
    for (const root of roots) {
      if (dir === root) {
        if (!isIndexName(d.rel)) out.add(d.rel);
      } else if (dirname(dir) === root) {
        const hasIndex = idx.docs.some((x) => dirname(x.rel) === dir && isIndexName(x.rel));
        if (hasIndex ? isIndexName(d.rel) : !isEntryPoint(d.rel)) out.add(d.rel);
      }
    }
  }
  return [...out].sort();
}

export function indexDocs(ctx: Ctx, idx: DocIndex): string[] {
  const candidates = ["README.md", ...ctx.policy.docs.roots.flatMap((r) => [`${r}/README.md`, `${r}/index.md`])];
  return candidates.filter((c) => idx.fileSet.has(c));
}

/** Alvos (arquivos) citados pelos documentos de índice. `ignoreManaged` desconsidera o bloco gerado pelo repo-score. */
export function indexedTargets(idx: DocIndex, indexes: string[], ignoreManaged = false): Set<string> {
  const out = new Set<string>();
  for (const rel of indexes) {
    const doc = idx.docs.find((d) => d.rel === rel);
    if (!doc) continue;
    const refs: Ref[] = ignoreManaged
      ? extractRefs(stripManagedBlock(doc.text)).map((r) => ({ ...r, resolved: resolveTarget(r.kind, r.raw, rel, idx.fileSet, idx.dirSet) }))
      : (idx.refs.get(rel) ?? []);
    for (const r of refs) {
      if (!r.resolved) continue;
      out.add(r.resolved);
      if (idx.dirSet.has(r.resolved)) for (const f of idx.fileSet) if (dirname(f) === r.resolved && isIndexName(f)) out.add(f);
    }
  }
  return out;
}

export const d5Index: Collector = {
  ids: ["D5"],
  async run(ctx) {
    const idx = getDocIndex(ctx);
    const top = topLevelDocs(ctx, idx);
    if (top.length === 0) return [notApplicable("D5", "o repo não tem documentos além do README")];
    const indexes = indexDocs(ctx, idx);
    if (indexes.length === 0) {
      return [measured("D5", 0, [jobEvidence("d5-index", `sem índice (README.md ou docs/README.md); ${top.length} documentos de primeiro nível`)])];
    }
    const listed = indexedTargets(idx, indexes);
    const missing = top.filter((t) => !listed.has(t));
    const evidence: Evidence[] = missing.map((m) => ({ kind: "file" as const, path: m, line: 1, note: `não aparece no índice (${indexes.join(", ")})` }));
    if (evidence.length === 0) evidence.push({ kind: "file", path: indexes[0]!, line: 1, note: `${top.length} documentos de primeiro nível, todos no índice` });
    return [measured("D5", round(((top.length - missing.length) / top.length) * 100, 1), capEvidence(evidence))];
  },
};

/** `refsOverride` troca as referências de alguns documentos (ex.: o índice sem o bloco gerado), para planejar com idempotência. */
export function orphanDocs(idx: DocIndex, refsOverride?: Map<string, Ref[]>): { considered: string[]; orphans: string[] } {
  const inbound = new Map<string, Set<string>>();
  const add = (target: string, from: string) => inbound.set(target, (inbound.get(target) ?? new Set()).add(from));
  for (const [doc, baseRefs] of idx.refs) {
    const refs = refsOverride?.get(doc) ?? baseRefs;
    for (const r of refs) {
      if (!r.resolved) continue;
      if (idx.dirSet.has(r.resolved)) {
        for (const f of idx.fileSet) if (dirname(f) === r.resolved && isIndexName(f)) add(f, doc);
      } else add(r.resolved, doc);
    }
  }
  const considered = idx.docs.map((d) => d.rel).filter((r) => !isEntryPoint(r));
  const orphans = considered.filter((r) => [...(inbound.get(r) ?? [])].every((from) => from === r) );
  return { considered, orphans };
}

export const d6Orphans: Collector = {
  ids: ["D6"],
  async run(ctx) {
    const idx = getDocIndex(ctx);
    const { considered, orphans } = orphanDocs(idx);
    if (considered.length === 0) return [notApplicable("D6", "o repo não tem documentos além dos de convenção (README, OWNERS, SKILL)")];
    const evidence: Evidence[] = orphans.map((o) => ({ kind: "file" as const, path: o, line: 1, note: "nenhum documento aponta para este" }));
    if (evidence.length === 0) evidence.push(jobEvidence("d6-orphans", `${considered.length} documentos, todos referenciados`));
    return [measured("D6", round(((considered.length - orphans.length) / considered.length) * 100, 1), capEvidence(evidence))];
  },
};

