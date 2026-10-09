import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRubric, type CriterionDef, type Rubric } from "../src/schema/rubric.js";
import type { CriterionResult, Profile, ResultsFile } from "../src/schema/evidence.js";
import type { Points } from "../src/scorer/score-criterion.js";

export const RUBRIC_PATH = fileURLToPath(new URL("../skill/references/rubric.json", import.meta.url));

export function loadRubric(): Rubric {
  return parseRubric(JSON.parse(readFileSync(RUBRIC_PATH, "utf8")));
}

export const ALL_PROFILE: Profile = {
  rules_engine: true,
  has_database: true,
  exposes_api: true,
  east_west_standard_defined: true,
};

export function allCriteria(r: Rubric): CriterionDef[] {
  return r.dimensions.flatMap((d) => d.criteria);
}

/** Um valor que produz exatamente `pts` pontos no critério. */
export function valueFor(def: CriterionDef, pts: Points): number | string {
  if (def.direction === "boolean") {
    if (pts === 2) return def.points["2"] as string;
    if (pts === 1) return def.points["1"] as string;
    return def.states!.find((s) => s !== def.points["2"] && s !== def.points["1"])!;
  }
  const p2 = def.points["2"] as number;
  const p1 = def.points["1"] as number;
  if (pts === 2) return p2;
  if (pts === 1) return p1;
  return def.direction === "lower" ? p1 + 1 : p1 - 1;
}

export function measured(def: CriterionDef, pts: Points): CriterionResult {
  return {
    id: def.id,
    status: "measured",
    value: valueFor(def, pts),
    evidence: [{ kind: "job", name: "fixture" }],
  };
}

/** Resultados de todos os critérios com `base` pontos, com sobrescritas por id. */
export function build(
  rubric: Rubric,
  opts: {
    base?: Points;
    override?: Record<string, Points | CriterionResult>;
    profile?: Partial<Profile>;
    skip?: string[];
  } = {},
): ResultsFile {
  const base = opts.base ?? 2;
  const results: CriterionResult[] = [];
  for (const def of allCriteria(rubric)) {
    if (opts.skip?.includes(def.id)) continue;
    const o = opts.override?.[def.id];
    if (o === undefined) results.push(measured(def, base));
    else if (typeof o === "number") results.push(measured(def, o));
    else results.push(o);
  }
  return { repo: "fixture", profile: { ...ALL_PROFILE, ...opts.profile }, results };
}
