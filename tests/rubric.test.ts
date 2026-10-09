import { describe, expect, it } from "vitest";
import { RubricSchema } from "../src/schema/rubric.js";
import { allCriteria, loadRubric } from "./helpers.js";

describe("rubric.json (v2.3)", () => {
  const rubric = loadRubric();

  it("tem 7 dimensões com pesos que somam 100", () => {
    expect(rubric.dimensions).toHaveLength(7);
    expect(rubric.dimensions.reduce((s, d) => s + d.weight, 0)).toBe(100);
    expect(Object.fromEntries(rubric.dimensions.map((d) => [d.id, d.weight]))).toEqual({
      security: 20,
      tests: 20,
      code: 10,
      architecture: 15,
      operability: 20,
      documentation: 10,
      process: 5,
    });
  });

  it("tem 71 critérios com ids únicos, na contagem de cada dimensão", () => {
    const all = allCriteria(rubric);
    expect(all).toHaveLength(71);
    expect(new Set(all.map((c) => c.id)).size).toBe(71);
    expect(Object.fromEntries(rubric.dimensions.map((d) => [d.id, d.criteria.length]))).toEqual({
      security: 13,
      tests: 9,
      code: 12,
      architecture: 12,
      operability: 10,
      documentation: 9,
      process: 6,
    });
  });

  it("gates são exatamente S1, S3 e S6", () => {
    expect(
      allCriteria(rubric)
        .filter((c) => c.blocking)
        .map((c) => c.id),
    ).toEqual(["S1", "S3", "S6"]);
  });

  it("perfis ligam e desligam os critérios documentados", () => {
    const byProfile: Record<string, string[]> = {};
    for (const c of allCriteria(rubric)) {
      if (c.profile) (byProfile[c.profile] ??= []).push(c.id);
    }
    expect(byProfile).toEqual({
      rules_engine: ["T4", "C10", "D7"],
      has_database: ["A2", "P3"],
      exposes_api: ["S6"],
      east_west_standard_defined: ["S10"],
    });
  });

  it("D9 é zerado por A8", () => {
    expect(allCriteria(rubric).find((c) => c.id === "D9")?.zeroed_by).toBe("A8");
  });

  it("escala de notas confere com a seção 4.1", () => {
    expect(rubric.calculation.grades.map((g) => [g.grade, g.min_total])).toEqual([
      ["S", 97],
      ["A", 90],
      ["B", 75],
      ["C", 60],
      ["D", 40],
      ["E", 0],
    ]);
    expect(rubric.calculation.gate_cap).toBe("C");
  });

  it("rejeita critério boolean sem states e ids duplicados", () => {
    const bad = structuredClone(rubric);
    delete (bad.dimensions[1]!.criteria[5] as { states?: string[] }).states; // T6
    expect(RubricSchema.safeParse(bad).success).toBe(false);

    const dup = structuredClone(rubric);
    dup.dimensions[0]!.criteria[1]!.id = "S1";
    expect(RubricSchema.safeParse(dup).success).toBe(false);
  });
});
