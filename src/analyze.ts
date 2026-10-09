import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALL_COLLECTORS as COLLECTORS, GROUP_MODULES } from "./groups/index.js";
import type { Panel } from "./groups/types.js";
import { buildSuggestions, type FixSuggestion } from "./remediation/suggest.js";
import { NOT_IMPLEMENTED, createCtx, git, notApplicable, unmeasured } from "./collectors/context.js";
import { resolveSelection, type EnabledGroups } from "./groups-config.js";
import { loadPolicy, resolveProfile } from "./policy.js";
import { reportsHome } from "./util/home.js";
import type { CriterionResult, ResultsFile } from "./schema/evidence.js";
import { parseRubric, type CriterionDef, type Grade, type Rubric } from "./schema/rubric.js";
import { compareRuns, type RunSummary } from "./scorer/compare.js";
import { score, type ScoreResult } from "./scorer/score.js";
import { verifyResults, type VerifyIssue } from "./verify/verify-evidence.js";

import { finalGrade, MIN_COVERAGE_FOR_GRADE, type FinalGrade } from "./scorer/final-grade.js";
export { finalGrade, MIN_COVERAGE_FOR_GRADE, type FinalGrade };

export const TOOL_VERSION = "0.1.0";

/** Motivo dos critérios de grupos que o usuário não escolheu avaliar. */
export const OUT_OF_SCOPE = "grupo fora do escopo desta análise";


export interface Opportunity {
  id: string;
  title: string;
  weight: number;
  dimension: string;
  from_points: 0 | 1;
  /** Aumento do total se o critério passar a 2 pontos. */
  gain: number;
  total_after: number;
  grade_after: Grade | null;
  /** Se o gate deixaria de limitar a nota. */
  unblocks_gate: boolean;
}

export interface ReportData {
  meta: {
    repo: string;
    path: string;
    branch: string | null;
    commit: string | null;
    dirty: boolean;
    generated_at: string;
    tool_version: string;
    rubric_version: string;
    policy_source: string | null;
    collectors: string[];
    /** Motivo usado para critérios sem coletor, para a UI separá-los dos não medidos por falta de fonte. */
    not_implemented_reason: string;
    out_of_scope_reason: string;
    min_coverage_for_grade: number;
    /** Grupos (dimensões) da rubrica e quais entraram nesta análise. */
    groups: { id: string; title: string; weight: number }[];
    selected_groups: string[];
    /** Grupos ativados na configuração (os únicos que podem ser escolhidos) e de onde vem essa configuração. */
    enabled_groups: string[];
    enabled_source: EnabledGroups["source"];
  };
  /** Nota final exibida: sempre uma letra; E quando a cobertura medida não basta. */
  final: FinalGrade;
  result: ScoreResult;
  opportunities: Opportunity[];
  previous: (RunSummary & { generated_at: string; commit: string | null; groups?: string[] }) | null;
  comparison: ReturnType<typeof compareRuns>;
  evidence_issues: VerifyIssue[];
  /** Painéis informativos dos grupos avaliados (ex.: "SDD: saúde" em Documentação). */
  panels: Panel[];
  /** Ações de correção dos grupos avaliados, ordenadas pelo ganho potencial de nota. */
  fixes: FixSuggestion[];
  /** Definições dos critérios, para a UI mostrar unidade e limiares. */
  criteria: Record<string, Pick<CriterionDef, "id" | "title" | "unit" | "direction" | "points" | "weight" | "sources" | "blocking" | "note">>;
}

export function targetValue(def: CriterionDef, points: 1 | 2): number | string {
  return def.points[points === 2 ? "2" : "1"];
}

/** Quanto cada critério abaixo de 2 pontos renderia no total se fosse corrigido (simulação "e se"). */
export function opportunities(rubric: Rubric, input: ResultsFile, base: ScoreResult): Opportunity[] {
  const defs = new Map<string, CriterionDef>();
  const dimOf = new Map<string, string>();
  for (const d of rubric.dimensions) for (const c of d.criteria) (defs.set(c.id, c), dimOf.set(c.id, d.id));
  const out: Opportunity[] = [];
  for (const dim of Object.values(base.dimensions)) {
    for (const o of dim.criteria) {
      if (o.state !== "scored" || o.points === 2) continue;
      const def = defs.get(o.id)!;
      const results = input.results.map((r) =>
        r.id === o.id
          ? ({ id: o.id, status: "measured", value: targetValue(def, 2), evidence: o.evidence.length ? o.evidence : [{ kind: "job", name: "simulacao" }] } as CriterionResult)
          : r,
      );
      if (!results.some((r) => r.id === o.id)) continue;
      const sim = score(rubric, { ...input, results });
      if (sim.total === null || base.total === null) continue;
      out.push({
        id: o.id,
        title: def.title,
        weight: def.weight,
        dimension: dimOf.get(o.id)!,
        from_points: o.points as 0 | 1,
        gain: sim.total - base.total,
        total_after: sim.total,
        grade_after: sim.grade,
        unblocks_gate: base.blocked_by.includes(o.id),
      });
    }
  }
  return out.sort((a, b) => Number(b.unblocks_gate) - Number(a.unblocks_gate) || b.gain - a.gain || b.weight - a.weight);
}

export { reportsHome };

export function repoSlug(root: string): string {
  const h = createHash("sha256").update(root).digest("hex").slice(0, 6);
  return `${path.basename(root).replace(/[^\w.-]+/g, "_")}-${h}`;
}

export interface AnalyzeOptions {
  root: string;
  rubricPath: string;
  policyPath?: string;
  /** Pasta de saída. Padrão: ~/.repo-score/<repo>-<hash>/ (nada é gravado dentro do repo analisado). */
  outDir?: string;
  /** Grupos (ids de dimensão) a avaliar. Omitido = todos. */
  groups?: string[];
  now?: Date;
}

export function resolveGroups(rubric: Rubric, groups?: string[]): string[] {
  const all = rubric.dimensions.map((d) => d.id);
  if (!groups || groups.length === 0) return all;
  const unknown = groups.filter((g) => !all.includes(g));
  if (unknown.length) throw new Error(`grupo desconhecido: ${unknown.join(", ")} (válidos: ${all.join(", ")})`);
  return all.filter((g) => groups.includes(g));
}

export interface AnalyzeOutput {
  data: ReportData;
  outDir: string;
  /** Resultados verificados e rubrica usados no cálculo (para simulações e projeções; não são serializados). */
  input: ResultsFile;
  rubric: Rubric;
}

export async function analyze(opts: AnalyzeOptions): Promise<AnalyzeOutput> {
  const root = path.resolve(opts.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`diretório não encontrado: ${root}`);

  const rubric = parseRubric(JSON.parse(readFileSync(opts.rubricPath, "utf8")));
  const { policy, source } = loadPolicy(root, opts.policyPath);
  const ctx = createCtx(root, policy, opts.now);
  const now = ctx.now;

  const { selected, enabled } = resolveSelection(rubric, opts.groups);
  const inScope = new Set(rubric.dimensions.filter((d) => selected.includes(d.id)).flatMap((d) => d.criteria.map((c) => c.id)));

  const collected: CriterionResult[] = [];
  for (const c of COLLECTORS) {
    if (!c.ids.some((id) => inScope.has(id))) continue; // grupo não escolhido: nem roda o coletor
    try {
      collected.push(...(await c.run(ctx)).filter((r) => inScope.has(r.id)));
    } catch (e) {
      for (const id of c.ids) if (inScope.has(id)) collected.push(unmeasured(id, `erro no coletor: ${(e as Error).message}`));
    }
  }
  const have = new Set(collected.map((r) => r.id));
  for (const d of rubric.dimensions) {
    for (const c of d.criteria) {
      if (have.has(c.id)) continue;
      collected.push(inScope.has(c.id) ? unmeasured(c.id, NOT_IMPLEMENTED) : notApplicable(c.id, OUT_OF_SCOPE));
    }
  }

  const verified = verifyResults(root, collected);
  const input: ResultsFile = {
    repo: path.basename(root),
    generated_at: now.toISOString(),
    rubric_version: rubric.version,
    profile: resolveProfile(policy),
    results: verified.results,
  };
  const result = score(rubric, input);

  const outDir = opts.outDir ?? path.join(reportsHome(), repoSlug(root));
  mkdirSync(outDir, { recursive: true });

  let previous: ReportData["previous"] = null;
  const latestFile = path.join(outDir, "latest.json");
  if (existsSync(latestFile)) {
    try {
      const p = JSON.parse(readFileSync(latestFile, "utf8")) as ReportData["previous"];
      if (p && typeof p.rubric_version === "string") previous = p;
    } catch {
      previous = null;
    }
  }
  const current: RunSummary = { rubric_version: rubric.version, total: result.total, grade: result.grade };
  const sameScope = !previous?.groups || previous.groups.join(",") === selected.join(",");
  const comparison: ReportData["comparison"] = sameScope
    ? compareRuns(previous, current, rubric.calculation.pr_regression.tolerance_points)
    : { status: "scope_changed", reason: "os grupos avaliados mudaram desde a análise anterior; a comparação foi suspensa" };

  const status = git(root, ["status", "--porcelain"]);
  const criteria: ReportData["criteria"] = {};
  for (const d of rubric.dimensions) {
    for (const c of d.criteria) {
      criteria[c.id] = { id: c.id, title: c.title, unit: c.unit, direction: c.direction, points: c.points, weight: c.weight, sources: c.sources, blocking: c.blocking, ...(c.note ? { note: c.note } : {}) };
    }
  }

  const data: ReportData = {
    meta: {
      repo: path.basename(root),
      path: root,
      branch: git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? null,
      commit: git(root, ["rev-parse", "--short", "HEAD"])?.trim() ?? null,
      dirty: status !== null && status.trim() !== "",
      generated_at: now.toISOString(),
      tool_version: TOOL_VERSION,
      rubric_version: rubric.version,
      policy_source: source,
      collectors: COLLECTORS.flatMap((c) => c.ids),
      not_implemented_reason: NOT_IMPLEMENTED,
      out_of_scope_reason: OUT_OF_SCOPE,
      min_coverage_for_grade: MIN_COVERAGE_FOR_GRADE,
      groups: rubric.dimensions.map((d) => ({ id: d.id, title: d.title, weight: d.weight })),
      selected_groups: selected,
      enabled_groups: enabled.enabled,
      enabled_source: enabled.source,
    },
    final: finalGrade(result),
    result,
    opportunities: opportunities(rubric, input, result),
    previous,
    comparison,
    evidence_issues: verified.issues,
    panels: GROUP_MODULES.filter((g) => selected.includes(g.id)).flatMap((g) => g.panels?.(ctx) ?? []),
    fixes: buildSuggestions({ root, ctx, rubric, input, base: result, groups: selected }),
    criteria,
  };
  return { data, outDir, input, rubric };
}

/** Grava resultado e histórico; mantém os 20 relatórios mais recentes. */
export function persist(outDir: string, data: ReportData, html: string): { json: string; html: string } {
  const stamp = data.meta.generated_at.replace(/[:.]/g, "-");
  const jsonFile = path.join(outDir, `result-${stamp}.json`);
  const htmlFile = path.join(outDir, `report-${stamp}.html`);
  writeFileSync(jsonFile, JSON.stringify(data, null, 2) + "\n");
  writeFileSync(htmlFile, html);
  const latest = {
    rubric_version: data.meta.rubric_version,
    total: data.result.total,
    grade: data.final.grade,
    generated_at: data.meta.generated_at,
    commit: data.meta.commit,
    groups: data.meta.selected_groups,
  };
  writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
  writeFileSync(path.join(outDir, "report.html"), html);
  for (const prefix of ["result-", "report-"]) {
    const files = readdirSync(outDir).filter((f) => f.startsWith(prefix)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) rmSync(path.join(outDir, f), { force: true });
  }
  return { json: jsonFile, html: htmlFile };
}
