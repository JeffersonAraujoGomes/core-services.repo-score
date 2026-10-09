import { z } from "zod";

export const GRADES = ["S", "A", "B", "C", "D", "E"] as const;
export type Grade = (typeof GRADES)[number];

export const PROFILE_FLAGS = [
  "rules_engine",
  "has_database",
  "exposes_api",
  "east_west_standard_defined",
] as const;
export type ProfileFlag = (typeof PROFILE_FLAGS)[number];

const threshold = z.union([z.number(), z.string()]);

export const CriterionDefSchema = z
  .object({
    id: z.string().regex(/^[A-Z]\d{1,2}$/),
    title: z.string().min(1),
    unit: z.string().min(1),
    direction: z.enum(["lower", "higher", "boolean"]),
    points: z.object({ "2": threshold, "1": threshold }),
    weight: z.number().positive(),
    sources: z.array(z.string()).min(1),
    blocking: z.boolean(),
    profile: z.enum(PROFILE_FLAGS).optional(),
    /** O que acontece quando o perfil desliga o critério. Padrão: not_applicable. S10 usa unmeasured (V35). */
    when_profile_off: z.enum(["not_applicable", "unmeasured"]).optional(),
    states: z.array(z.string()).optional(),
    note: z.string().optional(),
    zeroed_by: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const numeric = c.direction !== "boolean";
    for (const k of ["2", "1"] as const) {
      if (numeric !== (typeof c.points[k] === "number")) {
        ctx.addIssue({
          code: "custom",
          message: `${c.id}: points.${k} deve ser ${numeric ? "número" : "estado"} para direction=${c.direction}`,
        });
      }
    }
    if (c.direction === "boolean") {
      if (!c.states) {
        ctx.addIssue({ code: "custom", message: `${c.id}: critério boolean exige states` });
      } else {
        for (const k of ["2", "1"] as const) {
          if (!c.states.includes(String(c.points[k]))) {
            ctx.addIssue({ code: "custom", message: `${c.id}: points.${k} não está em states` });
          }
        }
      }
    }
  });
export type CriterionDef = z.infer<typeof CriterionDefSchema>;

export const DimensionDefSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  weight: z.number().positive(),
  criteria: z.array(CriterionDefSchema).min(1),
});
export type DimensionDef = z.infer<typeof DimensionDefSchema>;

export const RubricSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: z.string().optional(),
    source: z.string().optional(),
    /** Desvios locais em relação à rubrica oficial (informativo: o cálculo já usa os valores ajustados). */
    local_adjustments: z.array(z.object({ id: z.string(), field: z.string(), from: z.number(), to: z.number(), reason: z.string() })).optional(),
    calculation: z.object({
      grades: z
        .array(
          z.object({
            grade: z.enum(GRADES),
            min_total: z.number(),
            requires: z.literal("no_zero_no_gate").optional(),
            note: z.string().optional(),
          }),
        )
        .min(1),
      gate_cap: z.enum(GRADES),
      unmeasured_policy: z.enum(["exclude", "zero"]),
      pr_regression: z.object({ tolerance_points: z.number().min(0) }),
    }),
    dimensions: z.array(DimensionDefSchema).min(1),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    for (const d of r.dimensions) {
      for (const c of d.criteria) {
        if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `id duplicado: ${c.id}` });
        seen.add(c.id);
      }
    }
    for (const d of r.dimensions) {
      for (const c of d.criteria) {
        if (c.zeroed_by && !seen.has(c.zeroed_by)) {
          ctx.addIssue({ code: "custom", message: `${c.id}: zeroed_by aponta para id inexistente` });
        }
      }
    }
    const mins = r.calculation.grades.map((g) => g.min_total);
    if (!mins.every((m, i) => i === 0 || m < (mins[i - 1] as number))) {
      ctx.addIssue({ code: "custom", message: "grades devem estar em ordem decrescente de min_total" });
    }
  });
export type Rubric = z.infer<typeof RubricSchema>;

export function parseRubric(raw: unknown): Rubric {
  return RubricSchema.parse(raw);
}
