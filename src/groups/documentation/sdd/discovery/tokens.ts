import { SPEC_BUDGET } from "../spec-standard.js";
import type { PlannedSpec, SpecPlan } from "./plan.js";

/**
 * Modelo de custo da criação das specs. Premissas (calibradas em UMA execução real, n=1, no risk-services:
 * 3 subagentes escreveram 4 specs e 4 READMEs; previsto 96–295 mil tokens, realizado ≈ 460 mil):
 *  - cada lote de subagente paga uma partida fria (lê padrão, índice e specs de exemplo);
 *  - ler código custa mais que os caracteres do arquivo, porque o agente relê e explora os vizinhos;
 *  - escrever uma spec de ~80 linhas custa ≈ 2,4 mil tokens de saída e raciocínio.
 */
export const TOKEN_MODEL = {
  coldStartPerBatch: 40_000,
  readFactor: 2.2,
  writePerSpec: 2_400,
  docFactor: 1.3,
  overviewAndIndex: 15_000,
  skillFill: 12_000,
  verification: 10_000,
  rangeLow: 0.7,
  rangeHigh: 1.6,
  parallelBatches: 3,
  minutesPerBatch: 4.5,
} as const;

export interface TokenForecast {
  low: number;
  mid: number;
  high: number;
  batches: number;
  minutes: number;
  breakdown: { item: string; tokens: number }[];
  perSpec: Record<string, number>;
  basis: string;
}

const round = (n: number) => Math.round(n / 1000) * 1000;

export function specTokens(s: PlannedSpec): number {
  const read = (s.codeChars / 3.5) * TOKEN_MODEL.readFactor + s.docTokens * TOKEN_MODEL.docFactor;
  return Math.round(read + TOKEN_MODEL.writePerSpec);
}

export function forecastTokens(plan: SpecPlan, opts: { skillFill?: boolean } = {}): TokenForecast {
  const perSpec: Record<string, number> = {};
  for (const s of plan.specs) perSpec[s.id] = specTokens(s);

  const writable = plan.specs.filter((s) => s.kind !== "visao-geral" && s.kind !== "glossario");
  const batches = Math.max(1, Math.ceil(writable.length / SPEC_BUDGET.specsPerBatch));
  const specsTotal = Object.values(perSpec).reduce((a, b) => a + b, 0);
  const cold = batches * TOKEN_MODEL.coldStartPerBatch;
  const breakdown = [
    { item: `Leitura do código e escrita de ${plan.specs.length} specs`, tokens: specsTotal },
    { item: `Partida fria de ${batches} lote(s) de subagente (padrão, índice, exemplos)`, tokens: cold },
    { item: "Visão geral, glossário e índice", tokens: TOKEN_MODEL.overviewAndIndex },
    ...(opts.skillFill === false ? [] : [{ item: "Preencher a skill de domínio", tokens: TOKEN_MODEL.skillFill }]),
    { item: "Verificação (lint, ponteiros, nota)", tokens: TOKEN_MODEL.verification },
  ];
  const mid = breakdown.reduce((a, b) => a + b.tokens, 0);
  return {
    low: round(mid * TOKEN_MODEL.rangeLow),
    mid: round(mid),
    high: round(mid * TOKEN_MODEL.rangeHigh),
    batches,
    minutes: Math.ceil(batches / TOKEN_MODEL.parallelBatches) * TOKEN_MODEL.minutesPerBatch,
    breakdown,
    perSpec,
    basis: "calibrado em 1 execução real (previsto 96–295 mil, realizado ≈ 460 mil); a faixa alta cobre o desvio observado",
  };
}
