import path from "node:path";
import type { Ctx } from "../../../../collectors/context.js";
import type { CriterionResult, ResultsFile } from "../../../../schema/evidence.js";
import type { Rubric } from "../../../../schema/rubric.js";
import { finalGrade } from "../../../../scorer/final-grade.js";
import { score, type ScoreResult } from "../../../../scorer/score.js";
import { hasCommand } from "../../../../util/proc.js";
import { brokenRefs } from "../../collectors/d4-path-refs.js";
import { indexDocs, indexedTargets, orphanDocs, topLevelDocs } from "../../collectors/d5-d6-index.js";
import { getDocIndex } from "../../shared/docs-set.js";
import { readManifest } from "../../shared/manifest.js";
import { planSdd } from "../scaffold.js";
import { renderSpecSkeleton, SPEC_BLOCKS, SPEC_BUDGET } from "../spec-standard.js";
import { buildSpecPlan, plannedSiblings, type PlannedSpec, type SpecPlan } from "./plan.js";
import { forecastTokens, type TokenForecast } from "./tokens.js";

export interface Projection {
  label: string;
  grade: string;
  total: number | null;
  documentation: number | null;
  criteria: Record<string, number | null>;
  note: string;
}

export interface SimulationReport {
  repo: { name: string; path: string; branch: string | null; commit: string | null };
  detection: { sddPresent: boolean; specsDirExists: boolean; docsDirExists: boolean; manifest: string; hooks: boolean; reason: string };
  plan: SpecPlan;
  guardrails: { path: string; mode: string }[];
  guardrailNotes: string[];
  requirements: { tool: string; found: boolean; why: string }[];
  forecast: TokenForecast;
  sampleBrief: string;
  baseline: Projection;
  projections: Projection[];
  journey: { step: number; kind: "script" | "claude" | "usuario"; title: string; command: string; detail: string }[];
}

function summarize(label: string, r: ScoreResult, note: string): Projection {
  const f = finalGrade(r);
  const doc = r.dimensions["documentation"];
  const criteria: Record<string, number | null> = {};
  for (const c of doc?.criteria ?? []) criteria[c.id] = c.state === "scored" ? c.points : null;
  return { label, grade: f.grade, total: r.total, documentation: doc?.score_pct ?? null, criteria, note };
}

const override = (id: string, value: number | string): CriterionResult => ({ id, status: "measured", value, evidence: [{ kind: "job", name: "simulacao" }] });

function withOverrides(input: ResultsFile, o: CriterionResult[]): ResultsFile {
  const ids = new Set(o.map((r) => r.id));
  return { ...input, results: [...input.results.filter((r) => !ids.has(r.id)), ...o] };
}

/** Medição atual do grupo, feita pelo núcleo (o módulo de Documentação não chama o orquestrador). */
export interface SimulationBaseline {
  rubric: Rubric;
  input: ResultsFile;
  result: ScoreResult;
  meta: { repo: string; branch: string | null; commit: string | null };
}

export function simulateSdd(ctx: Ctx, base: SimulationBaseline, opts: { maxSpecs?: number } = {}): SimulationReport {
  const root = ctx.root;

  // 1. Detecção: o SDD é identificado pela pasta docs/specs na raiz
  const specsDirExists = ctx.files.some((f) => f.startsWith("docs/specs/"));
  const docsDirExists = ctx.files.some((f) => f.startsWith("docs/"));
  const manifest = readManifest(ctx);
  const hooks = ctx.files.some((f) => f.startsWith(".githooks/"));
  const detection = {
    sddPresent: specsDirExists,
    specsDirExists,
    docsDirExists,
    manifest: manifest.state,
    hooks,
    reason: specsDirExists ? "docs/specs existe na raiz: o SDD já foi adotado (use a ação de completar)" : docsDirExists ? "docs/ existe, mas docs/specs não: SDD ausente" : "nem docs/ existe: o repo parte do zero",
  };

  const plan = buildSpecPlan(ctx, { ...(opts.maxSpecs ? { maxSpecs: opts.maxSpecs } : {}) });
  const forecast = forecastTokens(plan);

  // 5. Guardrails: o que a adoção criaria (planejado em memória, nada é escrito)
  const sdd = planSdd(ctx, { rule_globs: plan.globs.join(","), specs_dir: plan.specsDir });
  const guardrails = (sdd?.changes ?? []).map((c) => ({ path: c.path, mode: c.op === "delete" ? "remover" : c.op === "modify" ? "alterar" : "criar" + (c.op === "create" && c.mode === "exec" ? " (executável)" : "") }));

  // 8. Projeção: nota atual (medida) e nota depois do plano (teto: assume o plano executado e validado)
  const idx = getDocIndex(ctx);
  const { total, broken } = brokenRefs(ctx);
  const newRefs = plan.specs.reduce((n, s) => n + s.pointers.length + (s.parent ? 1 : 0), 0);
  const d4 = total + newRefs === 0 ? null : ((total - broken.length + newRefs) / (total + newRefs)) * 100;

  const top = topLevelDocs(ctx, idx);
  const listed = indexedTargets(idx, indexDocs(ctx, idx));
  const d5 = ((top.filter((t) => listed.has(t)).length + 1) / (top.length + 1)) * 100; // docs/specs/README.md entra pelo link da seção SDD do README raiz

  const o = orphanDocs(idx);
  const d6 = ((o.considered.length - o.orphans.length + plan.specs.length) / (o.considered.length + plan.specs.length)) * 100; // todas as specs entram no índice de specs

  const { linked, siblings } = plannedSiblings(ctx, plan);
  const d7 = linked.length + siblings.length === 0 ? null : (linked.length / (linked.length + siblings.length)) * 100;

  const sddOnly: CriterionResult[] = [override("D4", d4 ?? 100), override("D5", d5), override("D6", d6), ...(d7 === null ? [] : [override("D7", d7)])];
  const a = score(base.rubric, withOverrides(base.input, sddOnly));

  const lifts: CriterionResult[] = [];
  for (const id of ["D1", "D2", "D3", "D5", "D6", "D8"]) {
    const def = base.rubric.dimensions.flatMap((d) => d.criteria).find((c) => c.id === id)!;
    const cur = a.dimensions["documentation"]?.criteria.find((c) => c.id === id);
    if (cur?.state === "scored" && cur.points < 2) lifts.push(override(id, def.points["2"]));
  }
  const b = score(base.rubric, withOverrides(withOverrides(base.input, sddOnly), lifts));

  const projections = [
    summarize("Depois do SDD (specs + guardrails + índice das specs)", a, "teto: assume as specs escritas e validadas pelo lint; D1, D2, D3 e D8 não mudam com o SDD"),
    summarize("SDD + demais ações (README, OWNERS, ADR, índice, higiene)", b, "teto: assume também D1, D2, D3, D5, D6 e D8 em 2 pontos (a spec de código não cobre README, OWNERS, ADR nem os docs antigos órfãos)"),
  ];

  const first = plan.specs.find((s) => s.kind === "regra") ?? plan.specs[0]!;
  const parent = first.parent ? plan.specs.find((s) => s.id === first.parent) : undefined;
  const sampleBrief = renderSpecSkeleton({
    id: first.id,
    title: first.title,
    ...(parent ? { parent: { id: parent.id, title: parent.title, file: parent.file } } : {}),
    files: first.pointers,
  });

  const journey: SimulationReport["journey"] = [
    { step: 1, kind: "script", title: "Detectar SDD", command: `repo-score plan "${root}"`, detail: "procura docs/specs na raiz; confere pré-requisitos (git, jq, claude)" },
    { step: 2, kind: "script", title: "Inventariar documentos e código", command: `repo-score sdd simulate "${root}"`, detail: "esta simulação; lê o repo e não escreve nada" },
    { step: 3, kind: "usuario", title: "Prévia e confirmação com o custo em tokens", command: `repo-score fix preview "${root}" --actions sdd-adopt`, detail: "lista os arquivos que seriam criados; você confirma o gasto" },
    { step: 4, kind: "script", title: "Criar a branch e os guardrails", command: `repo-score fix start "${root}" --actions sdd-adopt`, detail: "branch nova; manifest, hooks, settings, seção do README (0 tokens)" },
    { step: 5, kind: "claude", title: "Criar as specs em lotes", command: "(skill) subagentes por lote de até 6 specs", detail: "cada lote recebe o padrão, o esqueleto e os ponteiros; progresso por spec" },
    { step: 6, kind: "script", title: "Validar o padrão", command: `repo-score sdd lint "${root}"`, detail: "4 blocos, tamanho, ponteiros Arquivo: existentes, sem número de linha" },
    { step: 7, kind: "script", title: "Recalcular a nota na branch nova", command: `repo-score fix seal "${root}"`, detail: "antes/depois medidos, não estimados" },
    { step: 8, kind: "usuario", title: "Decidir: merge, manter ou descartar", command: `repo-score fix finish "${root}" --decision keep|merge|discard`, detail: "nada é enviado; ativar hooks é passo à parte" },
  ];

  return {
    repo: { name: base.meta.repo, path: root, branch: base.meta.branch, commit: base.meta.commit },
    detection,
    plan,
    guardrails,
    guardrailNotes: sdd?.notes ?? [],
    requirements: [
      { tool: "git", found: hasCommand("git"), why: "branch nova e histórico" },
      { tool: "jq", found: hasCommand("jq"), why: "os hooks leem o manifest com jq e ficam inativos sem ele" },
      { tool: "claude", found: hasCommand("claude"), why: "o sdd-analyze usa claude -p (tokens de quem commita spec)" },
    ],
    forecast,
    sampleBrief,
    baseline: summarize("Hoje", base.result, "medido"),
    projections,
    journey,
  };
}

const n = (x: number | null, d = 1) => (x === null ? "n/d" : (Math.floor(x * 10 ** d) / 10 ** d).toFixed(d));
const tk = (x: number) => x.toLocaleString("pt-BR");
const KIND: Record<PlannedSpec["kind"], string> = { "visao-geral": "visão geral", glossario: "glossário", orquestracao: "orquestração", regra: "regra", convertida: "convertida" };

export function formatSimulation(r: SimulationReport): string {
  const L: string[] = [];
  const rule = (t: string) => L.push("", `── ${t} ${"─".repeat(Math.max(2, 92 - t.length))}`);
  L.push("SIMULAÇÃO DO SDD — nada foi criado, alterado ou commitado");
  L.push(`Repo: ${r.repo.name} (${r.repo.branch ?? "?"}@${r.repo.commit ?? "?"})  ${r.repo.path}`);
  L.push("Legenda: [●] script, 0 tokens · [◆] o Claude trabalha, gasta tokens · [?] você decide");

  rule("PASSO A PASSO");
  const d = r.detection;
  const unconv = r.plan.docs.filter((x) => !x.convertible).length;
  const conv = r.plan.docs.filter((x) => x.convertible).length;
  L.push(` 1/8 [●] Detectar SDD ............ ${d.sddPresent ? "SDD presente" : "SDD AUSENTE"}: ${d.reason} (manifest: ${d.manifest}, hooks: ${d.hooks ? "sim" : "não"})`);
  L.push(` 2/8 [●] Inventariar documentos .. ${r.plan.stats.docsFound} documentos: ${conv} com regras de negócio (converter), ${unconv} descartados`);
  L.push(` 3/8 [●] Descobrir código de regra  ${r.plan.stats.ruleFiles} arquivos de regra em ${r.plan.apps.filter((a) => a.ruleFiles > 0).length} app(s); ${r.plan.stats.plumbingSkipped} de infraestrutura e ${r.plan.stats.lowSkipped} de baixa densidade ignorados`);
  L.push(` 4/8 [●] Planejar as specs ....... ${r.plan.specs.length} specs no padrão (${r.plan.specs.filter((s) => s.audience === "BUS").length} [BUS] regra de negócio, ${r.plan.specs.filter((s) => s.audience === "ENG").length} [ENG] técnicas)${r.plan.deferred.length ? ` (+${r.plan.deferred.length} adiadas por orçamento)` : ""}; perímetro de ${r.plan.globs.length} glob(s)`);
  L.push(` 5/8 [●] Guardrails (hooks) ...... ${r.guardrails.length} arquivos a criar, 0 tokens`);
  L.push(` 6/8 [?] Prévia e custo .......... ≈ ${tk(r.forecast.low)}–${tk(r.forecast.high)} tokens (central ${tk(r.forecast.mid)}) · ≈ ${r.forecast.minutes} min com ${r.forecast.batches} lote(s)`);
  L.push(` 7/8 [◆] Criar as specs .......... ${r.forecast.batches} lote(s) de até ${SPEC_BUDGET.specsPerBatch} specs, em paralelo`);
  L.push(` 8/8 [●] Validar e recalcular ..... lint do padrão + nota medida na branch nova`);

  rule("1. DETECÇÃO");
  L.push(`  docs/specs na raiz: ${d.specsDirExists ? "existe" : "não existe"} · docs/: ${d.docsDirExists ? "existe" : "não existe (será criada)"} · .sdd/manifest.json: ${d.manifest} · .githooks: ${d.hooks ? "existe" : "não existe"}`);

  rule("2. DOCUMENTOS EXISTENTES");
  const convs = r.plan.docs.filter((x) => x.convertible);
  if (convs.length === 0) L.push("  nenhum documento com regras de negócio: as specs saem só do código");
  for (const x of convs) L.push(`  converter  ${x.path}  (${tk(x.tokens)} tok, sinal ${x.signal}) → ${x.destination ? `spec ${x.destination}` : "sem destino"}`);
  const dropped = r.plan.docs.filter((x) => !x.convertible);
  if (dropped.length) L.push(`  descartados (${dropped.length}): ${dropped.slice(0, 6).map((x) => path.posix.basename(x.path)).join(", ")}${dropped.length > 6 ? ", …" : ""}`);

  rule("3. CÓDIGO DE REGRA POR APP");
  for (const a of r.plan.apps) L.push(`  ${a.name.padEnd(46)} ${String(a.ruleFiles).padStart(3)} arquivos de regra → ${a.planned} specs`);

  rule(`4. PLANO DE SPECS (padrão: 4 blocos, alvo ${SPEC_BUDGET.targetLines} e máximo ${SPEC_BUDGET.maxLines} linhas, ponteiros Arquivo:)`);
  L.push("  id     tipo          ptrs  cód.lin  tokens  arquivo / recorte");
  for (const s of r.plan.specs) {
    L.push(`  ${s.id.padEnd(6)} ${KIND[s.kind].padEnd(13)} ${String(s.pointers.length).padStart(4)} ${String(s.codeLines || "").padStart(8)} ${tk(r.forecast.perSpec[s.id] ?? 0).padStart(7)}  ${s.file}${s.subtopic ? `  [${s.subtopic}]` : ""}${s.sourceDocs.length ? `  ⟵ ${s.sourceDocs.map((x) => path.posix.basename(x)).join(", ")}` : ""}`);
    for (const note of s.notes.filter((x) => x.startsWith("nenhum"))) L.push(`         ⚠ ${note}`);
  }
  if (r.plan.deferred.length) L.push(`  adiadas (${r.plan.deferred.length}): ${r.plan.deferred.slice(0, 5).map((x) => x.title).join("; ")}${r.plan.deferred.length > 5 ? "; …" : ""}`);
  L.push(`  perímetro (ruleCodeGlobs): ${r.plan.globs.slice(0, 4).join(", ")}${r.plan.globs.length > 4 ? `, … (+${r.plan.globs.length - 4})` : ""}`);

  rule("5. GUARDRAILS (iguais aos do risk-services)");
  for (const g of r.guardrails) L.push(`  ${g.mode.padEnd(22)} ${g.path}`);
  for (const q of r.requirements) L.push(`  pré-requisito ${q.tool}: ${q.found ? "ok" : "AUSENTE"} — ${q.why}`);
  L.push("  fora da branch (passo à parte, com a sua confirmação): git config core.hooksPath .githooks");

  rule("6. PREVISÃO DE TOKENS");
  for (const b of r.forecast.breakdown) L.push(`  ${tk(b.tokens).padStart(9)}  ${b.item}`);
  L.push(`  ${"".padStart(9, "─")}`);
  L.push(`  ${tk(r.forecast.mid).padStart(9)}  central · faixa ${tk(r.forecast.low)}–${tk(r.forecast.high)} · ${r.forecast.basis}`);
  L.push("  custo recorrente do SDD: cada commit de spec roda claude -p (sdd-analyze) na conta de quem commita");

  rule("7. ESQUELETO QUE CADA TAREFA RECEBE (exemplo)");
  L.push(...r.sampleBrief.split("\n").map((l) => `  │ ${l}`));
  L.push(`  blocos obrigatórios, nesta ordem: ${SPEC_BLOCKS.join(" · ")}`);

  rule("8. NOTA DE DOCUMENTAÇÃO: HOJE × PROJEÇÃO");
  const rows = [r.baseline, ...r.projections];
  L.push("  cenário".padEnd(66) + "nota  total  Doc%   D1 D2 D3 D4 D5 D6 D7 D8");
  for (const p of rows) {
    L.push(`  ${p.label.padEnd(64)} ${p.grade.padEnd(5)} ${n(p.total).padStart(5)} ${n(p.documentation).padStart(5)}   ${["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8"].map((c) => (p.criteria[c] === null || p.criteria[c] === undefined ? "–" : String(p.criteria[c])).padStart(2)).join(" ")}`);
  }
  for (const p of r.projections) L.push(`  · ${p.label}: ${p.note}`);

  rule("JORNADA NA SKILL (o que o usuário verá, passo a passo)");
  for (const j of r.journey) L.push(`  ${j.step}. [${j.kind === "script" ? "●" : j.kind === "claude" ? "◆" : "?"}] ${j.title}\n       $ ${j.command}\n       ${j.detail}`);
  L.push("", "Nada foi escrito: nenhum arquivo, branch ou commit no repo. Esta saída pode ser repetida à vontade.");
  return L.join("\n");
}
