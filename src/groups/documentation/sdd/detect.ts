import type { Ctx } from "../../../collectors/context.js";
import { isTestPath } from "../../../collectors/context.js";

const CODE_EXT = /\.(cs|fs|go|kt|java|scala|ts|tsx|js|py|rb|php|rs|sql)$/i;
const RULE_DIR = /(^|\/)(rules?|regras?|policies|policy|validators?|calculat\w*|domain)\//i;

/** Pastas candidatas a "código de regra de negócio", para sugerir ruleCodeGlobs ao usuário (nunca aplicadas sozinhas). */
export function suggestRuleGlobs(ctx: Ctx, limit = 6): { glob: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const f of ctx.files) {
    if (!CODE_EXT.test(f) || isTestPath(f) || !RULE_DIR.test(f)) continue;
    const dir = f.slice(0, f.lastIndexOf("/"));
    const m = /^(.*?(?:rules?|regras?|policies|policy|validators?)[^/]*)(?:\/|$)/i.exec(dir);
    const base = m ? m[1]! : dir;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([dir, files]) => ({ glob: `${dir}/*`, files }));
}
