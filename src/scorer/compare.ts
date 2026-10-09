import type { Grade } from "../schema/rubric.js";

export interface RunSummary {
  rubric_version: string;
  total: number | null;
  grade: Grade | null;
}

export type Comparison =
  | { status: "rubric_changed"; reason: string }
  | { status: "scope_changed"; reason: string }
  | { status: "no_baseline" }
  | { status: "ok" | "regression"; delta: number };

/**
 * Regressão (V13/V14). Notas só são comparáveis na mesma versão da rubrica; se a versão
 * mudou, a comparação é suspensa e exige novo baseline.
 */
export function compareRuns(prev: RunSummary | null, curr: RunSummary, tolerancePoints: number): Comparison {
  if (!prev || prev.total === null || curr.total === null) return { status: "no_baseline" };
  if (prev.rubric_version !== curr.rubric_version) {
    return {
      status: "rubric_changed",
      reason: `rubrica ${prev.rubric_version} -> ${curr.rubric_version}: novo baseline necessário`,
    };
  }
  const delta = curr.total - prev.total;
  return { status: delta < -tolerancePoints - 1e-9 ? "regression" : "ok", delta };
}
