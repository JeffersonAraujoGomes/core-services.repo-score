import type { CriterionDef } from "../schema/rubric.js";

export type Points = 0 | 1 | 2;

export class ScoringError extends Error {}

/**
 * Pontuação de um critério (rubrica 4.2). Limiares inclusivos: igualdade conta a favor do repo.
 *  lower:   valor <= points.2 -> 2; valor <= points.1 -> 1; senão 0
 *  higher:  valor >= points.2 -> 2; valor >= points.1 -> 1; senão 0
 *  boolean: estado de points.2 -> 2; estado de points.1 -> 1; senão 0
 */
export function scoreValue(def: CriterionDef, value: number | string): Points {
  if (def.direction === "boolean") {
    if (typeof value !== "string") {
      throw new ScoringError(`${def.id}: esperado estado (${def.states?.join(", ")}), recebido número`);
    }
    if (!def.states?.includes(value)) {
      throw new ScoringError(`${def.id}: estado desconhecido "${value}" (válidos: ${def.states?.join(", ")})`);
    }
    if (value === def.points["2"]) return 2;
    if (value === def.points["1"]) return 1;
    return 0;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ScoringError(`${def.id}: esperado número finito, recebido ${JSON.stringify(value)}`);
  }
  const p2 = def.points["2"] as number;
  const p1 = def.points["1"] as number;
  if (def.direction === "lower") {
    if (value <= p2) return 2;
    if (value <= p1) return 1;
    return 0;
  }
  if (value >= p2) return 2;
  if (value >= p1) return 1;
  return 0;
}
