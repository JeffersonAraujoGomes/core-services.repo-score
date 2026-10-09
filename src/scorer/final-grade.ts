import type { Grade } from "../schema/rubric.js";
import type { ScoreResult } from "./score.js";

/**
 * Abaixo desta fração do peso medido (dentro do escopo escolhido), a nota é E: sem medição suficiente
 * não há evidência para atribuir mais que isso. Regra de apresentação sobre o resultado do motor.
 */
export const MIN_COVERAGE_FOR_GRADE = 0.5;


export interface FinalGrade {
  grade: Grade;
  /** Letra que o motor calculou sobre o que foi medido (null se nada foi medido). */
  computed_grade: Grade | null;
  /** Por que a nota final difere da calculada, ou null. */
  reason: "insufficient_coverage" | "nothing_measured" | null;
}

export function finalGrade(result: ScoreResult, minCoverage = MIN_COVERAGE_FOR_GRADE): FinalGrade {
  if (result.total === null || result.grade === null) {
    return { grade: "E", computed_grade: result.grade, reason: "nothing_measured" };
  }
  if (result.coverage.weight_ratio + 1e-9 < minCoverage) {
    return { grade: "E", computed_grade: result.grade, reason: "insufficient_coverage" };
  }
  return { grade: result.grade, computed_grade: result.grade, reason: null };
}
