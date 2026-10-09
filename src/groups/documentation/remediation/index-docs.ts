import path from "node:path";
import type { Ctx } from "../../../collectors/context.js";
import { readForEdit, upsert } from "../../../remediation/changes.js";
import type { ActionPlan } from "../../../remediation/types.js";
import { indexDocs, indexedTargets, orphanDocs, topLevelDocs } from "../collectors/d5-d6-index.js";
import { docTitle, extractRefs, getDocIndex, MANAGED_END, MANAGED_START, resolveTarget, stripManagedBlock, type Ref } from "../shared/docs-set.js";

const BLOCK_RE = new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}\\n?`);

export function renderBlock(indexRel: string, entries: { rel: string; title: string }[]): string {
  const dir = path.posix.dirname(indexRel);
  const lines = entries.map((e) => `- [${e.title}](${path.posix.relative(dir === "." ? "" : dir, e.rel)})`);
  return [
    MANAGED_START,
    "## Documentos ainda não indexados",
    "",
    "> Lista gerada pelo repo-score. Mova cada item para a seção certa deste índice e apague-o daqui.",
    "",
    ...lines,
    MANAGED_END,
    "",
  ].join("\n");
}

/** Lista só o que não está indexado fora do bloco gerado, para o resultado ser idempotente. */
export function planIndex(ctx: Ctx): ActionPlan | null {
  const idx = getDocIndex(ctx);
  const roots = ctx.policy.docs.roots;
  const docsRoot = roots.find((r) => ctx.files.some((f) => f.startsWith(`${r}/`)));
  const indexRel = docsRoot ? `${docsRoot}/README.md` : "README.md";
  const indexes = [...new Set([...indexDocs(ctx, idx), indexRel])].filter((i) => idx.fileSet.has(i));

  const listed = indexedTargets(idx, indexes, true);
  const top = topLevelDocs(ctx, idx).filter((t) => !listed.has(t));

  const override = new Map<string, Ref[]>();
  for (const rel of indexes) {
    const doc = idx.docs.find((d) => d.rel === rel);
    if (doc) override.set(rel, extractRefs(stripManagedBlock(doc.text)).map((r) => ({ ...r, resolved: resolveTarget(r.kind, r.raw, rel, idx.fileSet, idx.dirSet) })));
  }
  const orphans = orphanDocs(idx, override).orphans;

  const wanted = [...new Set([...top, ...orphans])].filter((r) => r !== indexRel).sort();
  const entries = wanted.map((rel) => ({ rel, title: docTitle(idx.docs.find((d) => d.rel === rel)!) }));

  const notes: string[] = [];
  const er = readForEdit(ctx, indexRel, notes);
  if (er.skip) return { changes: [], guided: [], notes, postSteps: [] };
  const existing = er.text;
  const hasBlock = existing !== null && BLOCK_RE.test(existing);
  if (entries.length === 0 && !hasBlock) return null;

  let next: string;
  if (entries.length === 0) next = (existing ?? "").replace(BLOCK_RE, "");
  else {
    const block = renderBlock(indexRel, entries);
    if (existing === null) next = `# Documentação\n\n${block}`;
    else if (hasBlock) next = existing.replace(BLOCK_RE, () => block);
    else next = `${existing}${existing.endsWith("\n") ? "\n" : "\n\n"}${block}`;
  }
  const change = upsert(ctx, indexRel, next, { note: `${entries.length} documentos listados no bloco gerado` });
  return change ? { changes: [change], guided: [], notes: [], postSteps: [] } : null;
}
