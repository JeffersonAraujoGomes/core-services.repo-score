import { hasCommand } from "../util/proc.js";
import { createCtx, type Ctx } from "../collectors/context.js";
import { GROUP_MODULES } from "../groups/index.js";
import type { CriterionResult, ResultsFile } from "../schema/evidence.js";
import type { Grade, Rubric } from "../schema/rubric.js";
import { score, type ScoreResult } from "../scorer/score.js";
import { optimizePrompt } from "./prompt.js";
import type { Action, ParamSpec } from "./types.js";

export interface FixSuggestion {
  id: string;
  group: string;
  title: string;
  summary: string;
  /** auto: só script; guided: o Claude redige (tokens); mixed: os dois; manual: só avisos. */
  kind: Action["kind"] | "manual";
  criteria: string[];
  changes: number;
  guided_tasks: number;
  notes: string[];
  post_steps: string[];
  tokens: { low: number; high: number; basis: string } | null;
  requires: { tool: string; found: boolean; why: string; blocking: boolean }[];
  params: ParamSpec[];
  /** Texto do botão "Otimizar nota": comando para colar na sessão do Claude; null quando a ação só traz avisos. */
  prompt: string | null;
  /** Teto: o que a nota seria se todos os critérios da ação medidos abaixo de 2 chegassem a 2. */
  potential: { criteria: string[]; gain_total: number; total_after: number | null; grade_after: Grade | null; dimension_pct_after: number | null } | null;
}

/** Valor que dá 2 pontos no critério (limiar de 2 pontos da rubrica). */
function targetFor(rubric: Rubric, id: string): number | string {
  for (const d of rubric.dimensions) for (const c of d.criteria) if (c.id === id) return c.points["2"];
  throw new Error(`critério desconhecido: ${id}`);
}

/** Pontua de novo com os critérios `ids` (medidos abaixo de 2) elevados a 2 pontos. */
export function simulateTargets(rubric: Rubric, input: ResultsFile, base: ScoreResult, ids: string[]): ScoreResult | null {
  const lifted = new Set<string>();
  for (const dim of Object.values(base.dimensions)) {
    for (const o of dim.criteria) if (ids.includes(o.id) && o.state === "scored" && o.points < 2) lifted.add(o.id);
  }
  if (lifted.size === 0) return null;
  const results = input.results.map((r): CriterionResult => {
    if (!lifted.has(r.id)) return r;
    const ev = r.status === "measured" && r.evidence.length ? r.evidence : [{ kind: "job" as const, name: "simulacao" }];
    return { id: r.id, status: "measured", value: targetFor(rubric, r.id), evidence: ev };
  });
  return score(rubric, { ...input, results });
}

export function buildSuggestions(args: {
  root: string;
  ctx: Ctx;
  rubric: Rubric;
  input: ResultsFile;
  base: ScoreResult;
  groups: string[];
}): FixSuggestion[] {
  const { ctx, rubric, input, base, groups } = args;
  const out: FixSuggestion[] = [];
  const outcomes = Object.values(base.dimensions).flatMap((d) => d.criteria);
  /** A ação só aparece se algum critério dela pode subir: medido abaixo de 2 ou ainda não medido. No máximo, não há o que otimizar. */
  const hasRoom = (ids: string[]) => ids.some((id) => outcomes.some((o) => o.id === id && ((o.state === "scored" && o.points < 2) || o.state === "unmeasured")));
  for (const g of GROUP_MODULES.filter((m) => groups.includes(m.id))) {
    for (const action of g.actions) {
      if (!hasRoom(action.criteria)) continue;
      const plan = action.plan(ctx, {});
      if (!plan) continue;
      const kind = plan.changes.length === 0 && plan.guided.length === 0 ? "manual" : action.kind;
      const sim = simulateTargets(rubric, input, base, action.criteria);
      const lifted = sim ? action.criteria.filter((id) => Object.values(base.dimensions).some((d) => d.criteria.some((o) => o.id === id && o.state === "scored" && o.points < 2))) : [];
      const dimPct = sim && base.total !== null ? Object.values(sim.dimensions).find((d) => d.criteria.some((o) => lifted.includes(o.id)))?.score_pct ?? null : null;
      out.push({
        id: action.id,
        group: action.group,
        title: action.title,
        summary: action.summary,
        kind,
        criteria: action.criteria,
        changes: plan.changes.length,
        guided_tasks: plan.guided.length,
        notes: plan.notes,
        post_steps: plan.postSteps,
        tokens: kind === "auto" || kind === "manual" ? null : (action.estimateTokens?.(ctx, {}) ?? null),
        requires: action.requires.map((r) => ({ tool: r.tool, found: hasCommand(r.tool, r.tool === "git" ? ["--version"] : ["--version"]), why: r.why, blocking: r.blocking })),
        params: action.params ?? [],
        prompt: kind === "manual" ? null : optimizePrompt(args.root, { id: action.id, group: action.group, title: action.title, criteria: action.criteria, kind }),
        potential: sim && base.total !== null && sim.total !== null
          ? { criteria: lifted, gain_total: sim.total - base.total, total_after: sim.total, grade_after: sim.grade, dimension_pct_after: dimPct }
          : null,
      });
    }
  }
  return out.sort((a, b) => (b.potential?.gain_total ?? -1) - (a.potential?.gain_total ?? -1));
}

export { createCtx };
