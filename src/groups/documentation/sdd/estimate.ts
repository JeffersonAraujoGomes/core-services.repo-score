import type { Ctx } from "../../../collectors/context.js";
import type { TokenEstimate } from "../../../remediation/types.js";
import { ruleFiles } from "../collectors/d7-specs-rules.js";

const CODE_EXT = /\.(cs|fs|go|kt|java|scala|ts|tsx|js|py|rb|php|rs|sql)$/i;

/**
 * Previsão (ordem de grandeza) dos tokens da descoberta do SDD: o Claude lê o código de regra, escreve as
 * specs e preenche a skill. Calibrar contra execuções reais antes de confiar; a faixa é propositalmente larga.
 */
export function estimateDiscoveryTokens(ctx: Ctx, ruleGlobs: string[]): TokenEstimate {
  const scoped = ruleGlobs.length ? ruleFiles(ctx, ruleGlobs) : [];
  const source = scoped.length ? scoped : ctx.files.filter((f) => CODE_EXT.test(f));
  const chars = source.reduce((s, f) => s + (ctx.readText(f)?.length ?? 0), 0);
  const reading = (chars / 3.5) * (scoped.length ? 1.8 : 0.35); // leitura + exploração; sem globs, só uma fração do código
  const specs = Math.min(60_000, reading * 0.3);
  const skill = 12_000;
  const mid = reading + specs + skill;
  return {
    low: Math.round((mid * 0.6) / 1000) * 1000,
    high: Math.round((mid * 1.8) / 1000) * 1000,
    basis: scoped.length
      ? `${scoped.length} arquivos de regra (~${Math.round(chars / 1000)} mil caracteres) lidos, specs escritas e skill preenchida`
      : `sem globs de regra: estimativa sobre ${source.length} arquivos de código do repo (menos confiável)`,
  };
}

/** Previsão para cobrir com specs uma lista conhecida de arquivos de regra (completar um SDD existente). */
export function estimateGapTokens(ctx: Ctx, files: string[]): TokenEstimate {
  const chars = files.reduce((s, f) => s + (ctx.readText(f)?.length ?? 0), 0);
  const reading = (chars / 3.5) * 1.8;
  const specs = Math.min(60_000, reading * 0.35);
  const mid = reading + specs + 6_000;
  return {
    low: Math.round((mid * 0.6) / 1000) * 1000,
    high: Math.round((mid * 1.8) / 1000) * 1000,
    basis: `${files.length} arquivos de regra sem spec (~${Math.round(chars / 1000)} mil caracteres) lidos e documentados`,
  };
}
