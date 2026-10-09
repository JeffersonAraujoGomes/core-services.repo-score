import type { Evidence, CriterionResult, ResultsFile } from "../schema/evidence.js";
import { GRADES, type CriterionDef, type Grade, type Rubric } from "../schema/rubric.js";
import { scoreValue, ScoringError, type Points } from "./score-criterion.js";

const EPS = 1e-9;

export type CriterionOutcome =
  | {
      id: string;
      state: "scored";
      weight: number;
      value: number | string | null;
      points: Points;
      evidence: Evidence[];
      confidence?: "high" | "medium" | "low";
      zeroed_by?: string;
    }
  | { id: string; state: "unmeasured"; weight: number; reason: string; counted_as_zero: boolean }
  | { id: string; state: "not_applicable"; weight: number; reason: string };

export interface DimensionOutcome {
  id: string;
  title: string;
  weight: number;
  /** null quando a dimensão inteira é N/A ou não mensurada: sai do total (V09). */
  score_pct: number | null;
  earned: number;
  max: number;
  criteria: CriterionOutcome[];
}

export interface ScoreResult {
  repo: string;
  rubric_version: string;
  generated_at?: string;
  dimensions: Record<string, DimensionOutcome>;
  /** Total sem arredondamento. null se nenhuma dimensão pôde ser calculada. */
  total: number | null;
  grade: Grade | null;
  blocked_by: string[];
  /** Critérios medidos com 0 ponto (impedem a nota S). */
  zero_criteria: string[];
  unmeasured: { id: string; reason: string }[];
  not_applicable: { id: string; reason: string }[];
  errors: { id: string; message: string }[];
  coverage: {
    applicable: number;
    measured: number;
    ratio: number;
    weight_applicable: number;
    weight_measured: number;
    weight_ratio: number;
  };
}

function applicableByProfile(def: CriterionDef, profile: ResultsFile["profile"]): boolean {
  return def.profile === undefined || profile[def.profile] === true;
}

function worse(a: Grade, b: Grade): Grade {
  return GRADES.indexOf(a) >= GRADES.indexOf(b) ? a : b;
}

/**
 * Agrega os resultados de critérios em dimensões, total, gates e nota (rubrica 4.3).
 * A nota nunca vem de um agente: sai só desta função, a partir de valores + evidências.
 */
export function score(rubric: Rubric, input: ResultsFile): ScoreResult {
  const errors: ScoreResult["errors"] = [];
  const defs = new Map<string, CriterionDef>();
  for (const d of rubric.dimensions) for (const c of d.criteria) defs.set(c.id, c);

  const byId = new Map<string, CriterionResult>();
  for (const r of input.results) {
    if (!defs.has(r.id)) {
      errors.push({ id: r.id, message: "critério inexistente na rubrica; resultado ignorado" });
      continue;
    }
    if (byId.has(r.id)) {
      errors.push({ id: r.id, message: "resultado duplicado; mantido o primeiro" });
      continue;
    }
    byId.set(r.id, r);
  }

  const zeroPolicy = rubric.calculation.unmeasured_policy === "zero";
  const outcomes = new Map<string, CriterionOutcome>();

  for (const def of defs.values()) {
    const w = def.weight;

    if (!applicableByProfile(def, input.profile)) {
      const reason = `perfil: ${def.profile}=false`;
      const explicit = byId.get(def.id);
      if (explicit?.status === "not_applicable") {
        // N/A declarado (ex.: grupo fora do escopo) vence o "não medido por perfil".
        outcomes.set(def.id, { id: def.id, state: "not_applicable", weight: w, reason: explicit.reason });
        continue;
      }
      // V35: sem o padrão definido, o critério sai do cálculo mas é listado como unmeasured,
      // independentemente da política de unmeasured (não é falha de fonte de dados).
      outcomes.set(
        def.id,
        def.when_profile_off === "unmeasured"
          ? { id: def.id, state: "unmeasured", weight: w, reason, counted_as_zero: false }
          : { id: def.id, state: "not_applicable", weight: w, reason },
      );
      continue;
    }

    const unmeasured = (reason: string): CriterionOutcome => ({
      id: def.id,
      state: "unmeasured",
      weight: w,
      reason,
      counted_as_zero: zeroPolicy,
    });

    const r = byId.get(def.id);
    if (!r) {
      outcomes.set(def.id, unmeasured("nenhum coletor produziu resultado"));
      continue;
    }
    if (r.status === "not_applicable") {
      outcomes.set(def.id, { id: def.id, state: "not_applicable", weight: w, reason: r.reason });
      continue;
    }
    if (r.status === "unmeasured") {
      outcomes.set(def.id, unmeasured(r.reason));
      continue;
    }

    // V20: pontuação sem evidência é inválida.
    if (r.evidence.length === 0) {
      errors.push({ id: def.id, message: "resultado sem evidência; critério invalidado" });
      outcomes.set(def.id, unmeasured("resultado sem evidência"));
      continue;
    }
    try {
      outcomes.set(def.id, {
        id: def.id,
        state: "scored",
        weight: w,
        value: r.value,
        points: scoreValue(def, r.value),
        evidence: r.evidence,
        ...(r.confidence ? { confidence: r.confidence } : {}),
      });
    } catch (e) {
      if (!(e instanceof ScoringError)) throw e;
      errors.push({ id: def.id, message: e.message });
      outcomes.set(def.id, unmeasured(e.message));
    }
  }

  // zeroed_by (ex.: D9 = 0 quando A8 = 0): vale mesmo que o dependente não tenha resultado.
  for (const def of defs.values()) {
    if (!def.zeroed_by) continue;
    const parent = outcomes.get(def.zeroed_by);
    const own = outcomes.get(def.id);
    if (parent?.state === "scored" && parent.points === 0 && own?.state !== "not_applicable") {
      outcomes.set(def.id, {
        id: def.id,
        state: "scored",
        weight: def.weight,
        value: own?.state === "scored" ? own.value : null,
        points: 0,
        evidence: parent.evidence,
        zeroed_by: def.zeroed_by,
      });
    }
  }

  const dimensions: Record<string, DimensionOutcome> = {};
  const blocked_by: string[] = [];
  const zero_criteria: string[] = [];
  const unmeasuredList: ScoreResult["unmeasured"] = [];
  const naList: ScoreResult["not_applicable"] = [];
  let applicable = 0;
  let measured = 0;
  let weightApplicable = 0;
  let weightMeasured = 0;
  let zeroFromPolicy = false;

  for (const dim of rubric.dimensions) {
    let earned = 0;
    let max = 0;
    const criteria: CriterionOutcome[] = [];
    for (const def of dim.criteria) {
      const o = outcomes.get(def.id) as CriterionOutcome;
      criteria.push(o);
      if (o.state === "not_applicable") {
        naList.push({ id: o.id, reason: o.reason });
        continue;
      }
      applicable += 1;
      weightApplicable += o.weight;
      if (o.state === "unmeasured") {
        unmeasuredList.push({ id: o.id, reason: o.reason });
        if (o.counted_as_zero) {
          max += 2 * o.weight;
          zeroFromPolicy = true;
        }
        continue;
      }
      measured += 1;
      weightMeasured += o.weight;
      earned += o.points * o.weight;
      max += 2 * o.weight;
      if (o.points === 0) {
        zero_criteria.push(o.id);
        if (defs.get(o.id)?.blocking) blocked_by.push(o.id);
      }
    }
    dimensions[dim.id] = {
      id: dim.id,
      title: dim.title,
      weight: dim.weight,
      score_pct: max > 0 ? (earned / max) * 100 : null,
      earned,
      max,
      criteria,
    };
  }

  let weighted = 0;
  let dimWeights = 0;
  for (const d of Object.values(dimensions)) {
    if (d.score_pct === null) continue;
    weighted += d.score_pct * d.weight;
    dimWeights += d.weight;
  }
  const total = dimWeights > 0 ? weighted / dimWeights : null;

  let grade: Grade | null = null;
  if (total !== null) {
    const hasZero = zero_criteria.length > 0 || zeroFromPolicy;
    const gated = blocked_by.length > 0;
    for (const g of rubric.calculation.grades) {
      if (total + EPS < g.min_total) continue;
      if (g.requires === "no_zero_no_gate" && (hasZero || gated)) continue;
      grade = g.grade;
      break;
    }
    if (grade !== null && gated) grade = worse(grade, rubric.calculation.gate_cap);
  }

  return {
    repo: input.repo,
    rubric_version: rubric.version,
    ...(input.generated_at ? { generated_at: input.generated_at } : {}),
    dimensions,
    total,
    grade,
    blocked_by,
    zero_criteria,
    unmeasured: unmeasuredList,
    not_applicable: naList,
    errors,
    coverage: {
      applicable,
      measured,
      ratio: applicable > 0 ? measured / applicable : 0,
      weight_applicable: weightApplicable,
      weight_measured: weightMeasured,
      weight_ratio: weightApplicable > 0 ? weightMeasured / weightApplicable : 0,
    },
  };
}
