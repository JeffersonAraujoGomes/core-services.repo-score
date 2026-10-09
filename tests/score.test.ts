import { describe, expect, it } from "vitest";
import { score } from "../src/scorer/score.js";
import { scoreValue } from "../src/scorer/score-criterion.js";
import { perKloc } from "../src/scorer/normalize.js";
import { compareRuns } from "../src/scorer/compare.js";
import type { Rubric } from "../src/schema/rubric.js";
import { allCriteria, build, loadRubric } from "./helpers.js";

const rubric = loadRubric();
const def = (id: string) => allCriteria(rubric).find((c) => c.id === id)!;

describe("pontuação por critério (4.2)", () => {
  it("V06: igualdade no limiar superior conta a favor do repo (higher)", () => {
    expect(scoreValue(def("T2"), 75.0)).toBe(2);
    expect(scoreValue(def("T2"), 74.99)).toBe(1);
    expect(scoreValue(def("T2"), 60)).toBe(1);
    expect(scoreValue(def("T2"), 59.99)).toBe(0);
  });

  it("V07: igualdade no limiar inferior (lower)", () => {
    expect(scoreValue(def("C1"), 2)).toBe(2);
    expect(scoreValue(def("C1"), 5.0)).toBe(1);
    expect(scoreValue(def("C1"), 5.01)).toBe(0);
  });

  it("limiares fracionários (S4: 0 / ≤0,5 por KLOC)", () => {
    expect(scoreValue(def("S4"), 0)).toBe(2);
    expect(scoreValue(def("S4"), 0.5)).toBe(1);
    expect(scoreValue(def("S4"), 0.51)).toBe(0);
  });

  it("V16: boolean parcial (T6 só com build) vale 1", () => {
    expect(scoreValue(def("T6"), "build+test")).toBe(2);
    expect(scoreValue(def("T6"), "build")).toBe(1);
    expect(scoreValue(def("T6"), "none")).toBe(0);
  });

  it("rejeita estado desconhecido e tipo errado em vez de pontuar", () => {
    expect(() => scoreValue(def("T6"), "tests")).toThrow(/estado desconhecido/);
    expect(() => scoreValue(def("T6"), 3)).toThrow();
    expect(() => scoreValue(def("T2"), "75")).toThrow();
    expect(() => scoreValue(def("T2"), Number.NaN)).toThrow();
  });

  it("V11: normalização por KLOC", () => {
    expect(perKloc(2, 40_000)).toBeCloseTo(0.05);
    // O documento (V11) diz "2 pontos", mas a tabela de S4 dá 2 pts só para 0 e 1 pt para <= 0,5.
    // O motor segue a tabela; a divergência está registrada em docs/spec-discrepancies.md.
    expect(scoreValue(def("S4"), perKloc(2, 40_000))).toBe(1);
    expect(perKloc(2, 2_000)).toBeCloseTo(1.0);
    expect(scoreValue(def("S4"), perKloc(2, 2_000))).toBe(0);
    expect(() => perKloc(1, 0)).toThrow();
  });
});

describe("agregação e nota (4.1 e 4.3)", () => {
  it("V01: repo perfeito -> 100, nota S", () => {
    const r = score(rubric, build(rubric));
    expect(r.total).toBeCloseTo(100);
    expect(r.grade).toBe("S");
    expect(r.blocked_by).toEqual([]);
    expect(r.coverage.ratio).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it("V02: um critério em 1 mantém S (S exige 'nenhum em 0', não 'todos em 2')", () => {
    const r = score(rubric, build(rubric, { override: { D8: 1 } }));
    expect(r.total!).toBeGreaterThanOrEqual(97);
    expect(r.zero_criteria).toEqual([]);
    expect(r.grade).toBe("S");
  });

  it("V03: um critério em 0 nega a S mesmo com total ≈ 99", () => {
    const r = score(rubric, build(rubric, { override: { D8: 0 } }));
    expect(r.total!).toBeGreaterThan(98.5);
    expect(r.zero_criteria).toEqual(["D8"]);
    expect(r.grade).toBe("A");
  });

  it("V04: gate limita a nota a C e informa blocked_by", () => {
    const r = score(rubric, build(rubric, { override: { S1: 0 } }));
    expect(r.total!).toBeGreaterThan(95);
    expect(r.blocked_by).toEqual(["S1"]);
    expect(r.grade).toBe("C");
  });

  it("gate não melhora uma nota que já é pior que C", () => {
    const r = score(rubric, build(rubric, { base: 0, override: { S1: 0 } }));
    expect(r.total).toBe(0);
    expect(r.grade).toBe("E");
    const d = score(rubric, build(rubric, { base: 1, override: { S3: 0 } }));
    expect(d.total!).toBeGreaterThan(40);
    expect(d.total!).toBeLessThan(60);
    expect(d.grade).toBe("D");
  });

  it("critério não-blocking em 0 não aciona gate (S7)", () => {
    const r = score(rubric, build(rubric, { override: { S7: 0 } }));
    expect(r.blocked_by).toEqual([]);
    expect(r.grade).toBe("A");
  });

  it("V05: exposes_api=false -> S6 fora do cálculo e sem gate, mesmo com resultado reportado", () => {
    const input = build(rubric, { profile: { exposes_api: false }, override: { S6: 0 } });
    const r = score(rubric, input);
    expect(r.not_applicable.map((n) => n.id)).toContain("S6");
    expect(r.blocked_by).toEqual([]);
    expect(r.zero_criteria).toEqual([]);
    expect(r.grade).toBe("S");
  });

  it("V35: sem ADR leste-oeste, S10 fica unmeasured (fora do cálculo, listado), mesmo com política 'zero'", () => {
    const input = build(rubric, { profile: { east_west_standard_defined: false } });
    const r = score(rubric, input);
    expect(r.unmeasured).toEqual([{ id: "S10", reason: "perfil: east_west_standard_defined=false" }]);
    expect(r.not_applicable).toEqual([]);
    expect(r.grade).toBe("S");
    const zeroRubric = structuredClone(rubric);
    zeroRubric.calculation.unmeasured_policy = "zero";
    expect(score(zeroRubric, input).dimensions.security!.max).toBe(2 * (27 - 2));
  });

  it("N/A explícito (grupo fora do escopo) vence o 'não medido por perfil' de S10", () => {
    const input = build(rubric, {
      profile: { east_west_standard_defined: false },
      override: { S10: { id: "S10", status: "not_applicable", reason: "grupo fora do escopo desta análise" } },
    });
    const r = score(rubric, input);
    expect(r.not_applicable.map((n) => n.id)).toContain("S10");
    expect(r.unmeasured.map((u) => u.id)).not.toContain("S10");
  });

  it("V08: N/A redistribui peso (denominador reduzido, não zerado)", () => {
    const input = build(rubric, { profile: { rules_engine: false }, override: { T1: 1 } });
    const r = score(rubric, input);
    expect(r.not_applicable.map((n) => n.id).sort()).toEqual(["C10", "D7", "T4"]);
    // Testes: pesos 3+3+1+2+3+2+2+1 = 17 (sem T4=2) -> max 34; T1 (peso 3) em 1 perde 3
    expect(r.dimensions.tests!.max).toBe(34);
    expect(r.dimensions.tests!.earned).toBe(31);
    expect(r.dimensions.tests!.score_pct).toBeCloseTo((31 / 34) * 100);
    expect(r.dimensions.code!.max).toBe(2 * (24 - 1)); // sem C10
    expect(r.dimensions.documentation!.max).toBe(2 * (13 - 1)); // sem D7
  });

  it("V09: dimensão inteira N/A sai do total (total ÷ 95)", () => {
    const na = allCriteria(rubric)
      .filter((c) => rubric.dimensions.find((d) => d.id === "process")!.criteria.includes(c))
      .map((c) => [c.id, { id: c.id, status: "not_applicable" as const, reason: "fixture" }]);
    const input = build(rubric, {
      override: { ...Object.fromEntries(na), S7: 0, S8: 0 },
      profile: { has_database: true },
    });
    const r = score(rubric, input);
    expect(r.dimensions.process!.score_pct).toBeNull();
    const dims = Object.values(r.dimensions).filter((d) => d.score_pct !== null);
    const expected = dims.reduce((s, d) => s + d.score_pct! * d.weight, 0) / 95;
    expect(r.total).toBeCloseTo(expected);
    expect(r.total!).toBeLessThan(100);
  });

  it("V10: fonte indisponível -> unmeasured sai do cálculo e é listado", () => {
    const input = build(rubric, {
      override: {
        O1: { id: "O1", status: "unmeasured", reason: "Datadog indisponível" },
        O2: { id: "O2", status: "unmeasured", reason: "Datadog indisponível" },
        O3: 0,
      },
    });
    const r = score(rubric, input);
    expect(r.unmeasured.map((u) => u.id)).toEqual(["O1", "O2"]);
    // Operabilidade sobre O3..O10: pesos 2+2+1+2+2+1+2+2 = 14; O3 (peso 2) em 0
    expect(r.dimensions.operability!.max).toBe(28);
    expect(r.dimensions.operability!.earned).toBe(24);
    expect(r.coverage.measured).toBe(69);
    expect(r.coverage.weight_ratio).toBeLessThan(1);
  });

  it("política unmeasured=zero conta o critério com 0 pontos no denominador", () => {
    const zeroRubric = structuredClone(rubric);
    zeroRubric.calculation.unmeasured_policy = "zero";
    const input = build(rubric, {
      override: { O1: { id: "O1", status: "unmeasured", reason: "Datadog indisponível" } },
    });
    const exclude = score(rubric, input);
    const zero = score(zeroRubric, input);
    expect(exclude.dimensions.operability!.score_pct).toBeCloseTo(100);
    expect(zero.dimensions.operability!.max).toBe(38);
    expect(zero.dimensions.operability!.earned).toBe(38 - 6);
    expect(zero.total!).toBeLessThan(exclude.total!);
    // 'zero' também nega a S: D8 não medido (peso 1) não derruba o total abaixo de 97, mas conta como 0
    const d8 = build(rubric, { override: { D8: { id: "D8", status: "unmeasured", reason: "x" } } });
    expect(score(rubric, d8).grade).toBe("S");
    expect(score(zeroRubric, d8).grade).toBe("A");
    // gate só dispara por evidência medida
    const gateInput = build(rubric, {
      override: { S1: { id: "S1", status: "unmeasured", reason: "sem acesso" } },
    });
    expect(score(zeroRubric, gateInput).blocked_by).toEqual([]);
  });

  it("V20: resultado sem evidência é invalidado como unmeasured e registra erro", () => {
    const input = build(rubric, {
      override: { T2: { id: "T2", status: "measured", value: 99, evidence: [] } },
    });
    const r = score(rubric, input);
    expect(r.unmeasured.find((u) => u.id === "T2")?.reason).toMatch(/sem evidência/);
    expect(r.errors.map((e) => e.id)).toContain("T2");
    const t2 = r.dimensions.tests!.criteria.find((c) => c.id === "T2")!;
    expect(t2.state).toBe("unmeasured");
  });

  it("critério sem resultado vira unmeasured; resultado de id desconhecido ou duplicado vira erro", () => {
    const input = build(rubric, { skip: ["T9"] });
    input.results.push({ id: "Z99", status: "unmeasured", reason: "x" });
    input.results.push({ id: "T2", status: "measured", value: 0, evidence: [{ kind: "job", name: "dup" }] });
    const r = score(rubric, input);
    expect(r.unmeasured.map((u) => u.id)).toEqual(["T9"]);
    expect(r.errors.map((e) => e.id).sort()).toEqual(["T2", "Z99"]);
    // o primeiro resultado de T2 (2 pontos) foi mantido
    expect(r.zero_criteria).toEqual([]);
  });

  it("valor inválido para o critério vira unmeasured com erro, não pontuação silenciosa", () => {
    const input = build(rubric, {
      override: {
        T6: { id: "T6", status: "measured", value: "tests-only", evidence: [{ kind: "job", name: "x" }] },
      },
    });
    const r = score(rubric, input);
    expect(r.unmeasured.map((u) => u.id)).toEqual(["T6"]);
    expect(r.errors[0]?.message).toMatch(/estado desconhecido/);
  });

  it("V23: diagrama ausente zera A8, A9, A10 e D9 (não N/A) e D9 segue A8 mesmo sem resultado", () => {
    const input = build(rubric, {
      override: { A8: 0, A9: 0, A10: 0 },
      skip: ["D9"],
    });
    const r = score(rubric, input);
    expect(r.zero_criteria.sort()).toEqual(["A10", "A8", "A9", "D9"]);
    expect(r.dimensions.architecture!.max).toBe(2 * 25); // denominador cheio
    expect(r.dimensions.documentation!.max).toBe(2 * 13);
    const d9 = r.dimensions.documentation!.criteria.find((c) => c.id === "D9")!;
    expect(d9).toMatchObject({ state: "scored", points: 0, zeroed_by: "A8" });
  });

  it("V25: A8 parcial (só C1) vale 1 e não zera D9", () => {
    const r = score(rubric, build(rubric, { override: { A8: 1 } }));
    const d9 = r.dimensions.documentation!.criteria.find((c) => c.id === "D9")!;
    expect(d9).toMatchObject({ state: "scored", points: 2 });
  });
});

describe("limiares de nota (4.1) com rubrica sintética", () => {
  /** Uma dimensão: criterion X1 (peso a, 2 pts) + X2 (peso b, `lowPts` pts) => pct = (2a + b*lowPts)/(2(a+b)). */
  function synth(): Rubric {
    return {
      ...structuredClone(rubric),
      dimensions: [
        {
          id: "only",
          title: "Única",
          weight: 100,
          criteria: ["X1", "X2"].map((id) => ({
            id,
            title: id,
            unit: "count",
            direction: "higher" as const,
            points: { "2": 2, "1": 1 },
            weight: 1,
            sources: ["repo"],
            blocking: false,
          })),
        },
      ],
    };
  }
  const run = (r: Rubric, w1: number, w2: number, v2: number) => {
    const rr = structuredClone(r);
    rr.dimensions[0]!.criteria[0]!.weight = w1;
    rr.dimensions[0]!.criteria[1]!.weight = w2;
    return score(rr, {
      repo: "s",
      profile: build(rubric).profile,
      results: [
        { id: "X1", status: "measured", value: 2, evidence: [{ kind: "job", name: "j" }] },
        { id: "X2", status: "measured", value: v2, evidence: [{ kind: "job", name: "j" }] },
      ],
    });
  };

  it("97 exato -> S; 96,5 -> A", () => {
    const s = synth();
    const exact = run(s, 94, 6, 1); // (188+6)/200 = 97
    expect(exact.total).toBeCloseTo(97);
    expect(exact.grade).toBe("S");
    expect(run(s, 93, 7, 1).total!).toBeLessThan(97); // 96.5
    expect(run(s, 93, 7, 1).grade).toBe("A");
  });

  it("75 exato -> B; 60 exato -> C; 40 exato -> D (inclusivos)", () => {
    const s = synth();
    expect(run(s, 3, 1, 0).total).toBeCloseTo(75);
    expect(run(s, 3, 1, 0).grade).toBe("B");
    expect(run(s, 1, 4, 1).total).toBeCloseTo(60); // (2+4)/10
    expect(run(s, 1, 4, 1).grade).toBe("C");
    expect(run(s, 2, 8, 0).total).toBeCloseTo(20);
    expect(run(s, 2, 8, 0).grade).toBe("E");
    expect(run(s, 1, 1, 0).total).toBeCloseTo(50);
    expect(run(s, 1, 1, 0).grade).toBe("D");
    expect(run(s, 2, 3, 0).total).toBeCloseTo(40);
    expect(run(s, 2, 3, 0).grade).toBe("D");
  });
});

describe("exemplo numérico da seção 4.4", () => {
  /** Dimensão hipotética com pct exato: pares (peso, pontos). Σpeso = 10 => earned = pct/10. */
  function dim(id: string, weight: number, pairs: [number, 0 | 1 | 2][]): Rubric["dimensions"][number] {
    return {
      id,
      title: id,
      weight,
      criteria: pairs.map(([w], i) => ({
        id: `${id[0]!.toUpperCase()}${i + 1}`,
        title: "x",
        unit: "count",
        direction: "higher" as const,
        points: { "2": 2, "1": 1 },
        weight: w,
        sources: ["repo"],
        blocking: false,
      })),
    };
  }

  it("Segurança 35/42 = 83,3 e total 76,16 -> B; com S1=0 e gate -> C", () => {
    // Segurança: S1..S9, pesos 3·2·3·2·2·3·3·2·1, pontos 2·2·2·1·2·2·1·2·0
    const secW = [3, 2, 3, 2, 2, 3, 3, 2, 1];
    const secP: (0 | 1 | 2)[] = [2, 2, 2, 1, 2, 2, 1, 2, 0];
    const security = {
      id: "security",
      title: "Segurança",
      weight: 20,
      criteria: secW.map((w, i) => ({
        id: `S${i + 1}`,
        title: "x",
        unit: "count",
        direction: "higher" as const,
        points: { "2": 2, "1": 1 },
        weight: w,
        sources: ["repo"],
        blocking: i === 0,
      })),
    };
    const mk = (id: string, w: number, pct: number): Rubric["dimensions"][number] => {
      // Σpeso = 10 (ou 4 para 75): pesos (a, b) com a em 2 pts e b em 0
      const sum = pct === 75 ? 4 : 10;
      const a = pct === 100 ? sum : (pct / 100) * sum;
      return dim(id, w, pct === 100 ? [[sum, 2]] : [[a, 2], [sum - a, 0]]);
    };
    const dims = [
      security,
      mk("tests", 20, 70),
      mk("code", 10, 90),
      mk("architecture", 15, 80),
      mk("operability", 20, 60),
      mk("documentation", 10, 75),
      mk("process", 5, 100),
    ];
    const synthetic: Rubric = { ...structuredClone(rubric), dimensions: dims };
    const results = (s1: 0 | 2) => {
      const out: ReturnType<typeof build>["results"] = [];
      secP.forEach((p, i) => {
        const pts = i === 0 ? s1 : p;
        out.push({ id: `S${i + 1}`, status: "measured", value: pts, evidence: [{ kind: "job", name: "j" }] });
      });
      for (const d of dims.slice(1)) {
        d.criteria.forEach((c, i) => {
          const isLow = d.id !== "process" && i === 1;
          out.push({ id: c.id, status: "measured", value: isLow ? 0 : 2, evidence: [{ kind: "job", name: "j" }] });
        });
      }
      return out;
    };
    const profile = build(rubric).profile;

    const ok = score(synthetic, { repo: "ex", profile, results: results(2) });
    expect(ok.dimensions.security!.earned).toBe(35);
    expect(ok.dimensions.security!.max).toBe(42);
    expect(ok.dimensions.security!.score_pct).toBeCloseTo(83.33, 1);
    expect(ok.total).toBeCloseTo(76.1667, 3); // 7616,67/100; o documento arredonda 83,3 -> 76,2
    expect(ok.grade).toBe("B");

    const gated = score(synthetic, { repo: "ex", profile, results: results(0) });
    expect(gated.blocked_by).toEqual(["S1"]);
    expect(gated.total!).toBeLessThan(75);
    expect(gated.grade).toBe("C");
  });
});

describe("regressão em PR (V13, V14)", () => {
  const sum = (total: number, v = "2.3.0") => ({ rubric_version: v, total, grade: null });

  it("V13: 82 -> 81 com tolerância 0 reprova; igual ou maior passa", () => {
    expect(compareRuns(sum(82), sum(81), 0)).toMatchObject({ status: "regression", delta: -1 });
    expect(compareRuns(sum(82), sum(82), 0).status).toBe("ok");
    expect(compareRuns(sum(82), sum(83), 0).status).toBe("ok");
  });

  it("tolerância permite queda pequena", () => {
    expect(compareRuns(sum(82), sum(81.5), 1).status).toBe("ok");
    expect(compareRuns(sum(82), sum(80.9), 1).status).toBe("regression");
  });

  it("V14: mudança de rubrica suspende a comparação", () => {
    expect(compareRuns(sum(82, "2.0.0"), sum(81, "2.1.0"), 0).status).toBe("rubric_changed");
  });

  it("sem baseline não reprova", () => {
    expect(compareRuns(null, sum(50), 0).status).toBe("no_baseline");
  });
});
