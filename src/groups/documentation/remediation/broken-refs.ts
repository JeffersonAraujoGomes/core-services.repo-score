import path from "node:path";
import type { Ctx } from "../../../collectors/context.js";
import { readForEdit, upsert } from "../../../remediation/changes.js";
import type { ActionPlan, FileChange } from "../../../remediation/types.js";
import { brokenRefs } from "../collectors/d4-path-refs.js";
import { basename, dirname, getDocIndex } from "../shared/docs-set.js";

/** Destino inequívoco para uma referência quebrada: o único arquivo do repo com o mesmo nome (null se não há ou há vários). */
export function refSuggester(ctx: Ctx): (b: { doc: string; raw: string; kind: string }) => { target: string | null; candidates: number } {
  const byName = new Map<string, string[]>();
  for (const f of ctx.files) byName.set(basename(f), [...(byName.get(basename(f)) ?? []), f]);
  return (b) => {
    const cands = (byName.get(basename(b.raw)) ?? []).filter((c) => c !== b.doc);
    return { target: cands.length === 1 ? cands[0]! : null, candidates: cands.length };
  };
}

/** Corrige só referências quebradas cujo arquivo de destino é inequívoco (mesmo nome em um único lugar do repo). */
export function planBrokenRefs(ctx: Ctx): ActionPlan | null {
  const { broken } = brokenRefs(ctx);
  if (broken.length === 0) return null;
  const idx = getDocIndex(ctx);
  const byName = new Map<string, string[]>();
  for (const f of ctx.files) byName.set(basename(f), [...(byName.get(basename(f)) ?? []), f]);

  const edits = new Map<string, { line: number; from: string; to: string }[]>();
  const notes: string[] = [];
  for (const b of broken) {
    const cands = (byName.get(basename(b.raw)) ?? []).filter((c) => c !== b.doc);
    if (cands.length !== 1) {
      if (notes.length < 12) notes.push(`${b.doc}:${b.line} → ${b.raw}: ${cands.length === 0 ? "nenhum arquivo com esse nome" : `${cands.length} candidatos`}; corrigir manualmente.`);
      continue;
    }
    const target = cands[0]!;
    const to = b.kind === "link" ? path.posix.relative(dirname(b.doc), target) : target;
    edits.set(b.doc, [...(edits.get(b.doc) ?? []), { line: b.line, from: b.raw, to }]);
  }

  const changes: FileChange[] = [];
  for (const [doc, list] of edits) {
    const er = readForEdit(ctx, doc, notes);
    if (er.skip) continue;
    const lines = (er.text ?? "").split("\n");
    for (const e of list) {
      const i = e.line - 1;
      if (lines[i] !== undefined && lines[i]!.includes(e.from)) lines[i] = lines[i]!.replace(e.from, () => e.to);
    }
    const c = upsert(ctx, doc, lines.join("\n"), { note: `${list.length} referência(s) corrigida(s) para o único arquivo de mesmo nome` });
    if (c) changes.push(c);
  }
  if (changes.length === 0 && notes.length === 0) return null;
  return { changes, guided: [], notes, postSteps: [] };
}
