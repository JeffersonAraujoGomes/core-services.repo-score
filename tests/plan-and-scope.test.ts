import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze, finalGrade, persist, resolveGroups } from "../src/analyze.js";
import { estimateSession, formatPlan, plan } from "../src/plan.js";
import { renderReport } from "../src/report/render.js";
import { score } from "../src/scorer/score.js";
import { allCriteria, build, loadRubric, RUBRIC_PATH } from "./helpers.js";
import { cleanupFixtures, makeRepo } from "./fixture-repo.js";

const rubric = loadRubric();
const homes: string[] = [];
const home = () => {
  const d = mkdtempSync(path.join(tmpdir(), "rs-home-"));
  homes.push(d);
  return d;
};
afterAll(() => {
  cleanupFixtures();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("nota final: sempre uma letra, E quando a cobertura não basta", () => {
  it("cobertura de peso abaixo de 50% vira E e guarda a letra calculada", () => {
    const input = build(rubric, {
      skip: allCriteria(rubric).filter((c) => !["S1", "S2"].includes(c.id)).map((c) => c.id),
    });
    const result = score(rubric, input);
    expect(result.grade).toBe("S"); // o motor, sobre o que foi medido
    expect(result.coverage.weight_ratio).toBeLessThan(0.5);
    expect(finalGrade(result)).toEqual({ grade: "E", computed_grade: "S", reason: "insufficient_coverage" });
  });

  it("com cobertura suficiente mantém a letra do motor (inclusive o limite de 50%)", () => {
    const full = score(rubric, build(rubric));
    expect(finalGrade(full)).toEqual({ grade: "S", computed_grade: "S", reason: null });
    expect(finalGrade({ ...full, coverage: { ...full.coverage, weight_ratio: 0.5 } }).reason).toBeNull();
    expect(finalGrade({ ...full, coverage: { ...full.coverage, weight_ratio: 0.499 } }).grade).toBe("E");
  });

  it("nada medido é E", () => {
    const none = score(rubric, build(rubric, { skip: allCriteria(rubric).map((c) => c.id) }));
    expect(none.total).toBeNull();
    expect(finalGrade(none)).toMatchObject({ grade: "E", reason: "nothing_measured" });
  });

  it("o gate continua valendo sobre a nota calculada (C no máximo)", () => {
    const gated = score(rubric, build(rubric, { override: { S1: 0 } }));
    expect(finalGrade(gated)).toEqual({ grade: "C", computed_grade: "C", reason: null });
  });
});

describe("grupos de análise", () => {
  it("resolveGroups: todos por padrão, na ordem da rubrica; rejeita desconhecidos", () => {
    expect(resolveGroups(rubric)).toHaveLength(7);
    expect(resolveGroups(rubric, ["process", "security"])).toEqual(["security", "process"]);
    expect(() => resolveGroups(rubric, ["seguranca"])).toThrow(/grupo desconhecido: seguranca/);
  });

  it("só os grupos escolhidos são medidos; os demais saem do cálculo como fora do escopo", async () => {
    const r = makeRepo();
    r.write("README.md", "x");
    r.commit("feat: a");
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: home(), groups: ["security"] });
    expect(data.meta.selected_groups).toEqual(["security"]);
    const dims = data.result.dimensions;
    expect(dims.security!.score_pct).not.toBeNull();
    for (const id of ["tests", "code", "architecture", "operability", "documentation", "process"]) {
      expect(dims[id]!.score_pct).toBeNull();
      expect(dims[id]!.criteria.every((c) => c.state === "not_applicable")).toBe(true);
    }
    // o total considera só o peso dos grupos avaliados (como dimensão N/A, V09)
    expect(data.result.total).toBeCloseTo(dims.security!.score_pct!);
    expect(data.result.not_applicable.some((n) => n.reason === data.meta.out_of_scope_reason)).toBe(true);
    // a cobertura é medida dentro do escopo
    expect(data.result.coverage.applicable).toBeLessThan(30);
  });

  it("não roda coletores de grupos não escolhidos", async () => {
    const r = makeRepo();
    r.write(".github/CODEOWNERS", "* @a\n/x @b\n/y @c\n");
    r.commit("feat: a");
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: home(), groups: ["security"] });
    const p6 = data.result.dimensions.process!.criteria.find((c) => c.id === "P6")!;
    expect(p6.state).toBe("not_applicable");
    const full = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: home() });
    expect(full.data.result.dimensions.process!.criteria.find((c) => c.id === "P6")).toMatchObject({ state: "scored", points: 2 });
  });

  it("mudar os grupos suspende a comparação com a análise anterior", async () => {
    const r = makeRepo();
    r.write("README.md", "x");
    r.commit("feat: a");
    const out = home();
    const first = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    persist(out, first.data, renderReport(first.data));
    const same = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    expect(same.data.comparison.status).toBe("ok");
    const narrowed = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out, groups: ["security"] });
    expect(narrowed.data.comparison.status).toBe("scope_changed");
  });

  it("o histórico guarda a nota final (letra exibida), não só a calculada", async () => {
    const r = makeRepo();
    r.write("README.md", "x");
    r.commit("feat: a");
    const out = home();
    const first = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    persist(out, first.data, renderReport(first.data));
    const second = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    expect(second.data.previous?.grade).toBe("E");
  });
});

describe("plan", () => {
  it("lista os 7 grupos, o que é mensurável e avisa que a nota será E com a cobertura da v0", () => {
    const r = makeRepo();
    r.write("README.md", "x");
    r.commit("feat: a");
    const p = plan({ root: r.root, rubricPath: RUBRIC_PATH });
    expect(p.blockers).toEqual([]);
    expect(p.groups.map((g) => g.id)).toEqual(["security", "tests", "code", "architecture", "operability", "documentation", "process"]);
    expect(Object.fromEntries(p.groups.map((g) => [g.id, g.measurable]))).toEqual({
      security: 5, tests: 0, code: 1, architecture: 0, operability: 0, documentation: 8, process: 3,
    });
    expect(p.selection.criteria).toBe(71);
    expect(p.selection.measurable).toBe(17);
    expect(p.selection.max_weight_coverage).toBeCloseTo(23 / 135, 3);
    expect(p.selection.grade_will_be_capped_at_e).toBe(true);
    expect(p.repo).toMatchObject({ is_git: true, branch: "main", dirty: false });
    expect(p.tools.find((t) => t.name === "node")).toMatchObject({ required: true, found: true });
    expect(p.warnings.some((w) => w.includes("repo-score.policy.json"))).toBe(true);
  });

  it("o escopo muda o que é medido e a cobertura máxima", () => {
    const r = makeRepo();
    r.write("README.md", "x");
    r.commit("feat: a");
    const sec = plan({ root: r.root, rubricPath: RUBRIC_PATH, groups: ["security"] });
    expect(sec.selection).toMatchObject({ groups: ["security"], criteria: 13, measurable: 5 });
    expect(sec.selection.max_weight_coverage).toBeCloseTo(8 / 27, 3);
    expect(sec.groups.filter((g) => g.selected).map((g) => g.id)).toEqual(["security"]);
  });

  it("caminho inexistente é bloqueio; diretório sem git é aviso", () => {
    expect(plan({ root: "/nao/existe/mesmo", rubricPath: RUBRIC_PATH }).blockers[0]).toMatch(/não existe/);
    const r = makeRepo({ git: false });
    r.write("a.txt", "x");
    const p = plan({ root: r.root, rubricPath: RUBRIC_PATH });
    expect(p.repo.is_git).toBe(false);
    expect(p.warnings.some((w) => w.includes("não é um repositório git"))).toBe(true);
  });

  it("a previsão de tokens: medição é 0, faixa coerente e cresce com o tamanho das instruções", () => {
    const r = makeRepo();
    r.write("README.md", "x");
    r.commit("feat: a");
    const p = plan({ root: r.root, rubricPath: RUBRIC_PATH });
    expect(p.estimate.measurement_tokens).toBe(0);
    expect(p.estimate.session_tokens.low).toBeGreaterThan(0);
    expect(p.estimate.session_tokens.high).toBeGreaterThan(p.estimate.session_tokens.low);
    expect(p.estimate.breakdown.reduce((s, b) => s + b.low, 0)).toBe(p.estimate.session_tokens.low);
    expect(p.estimate.breakdown.reduce((s, b) => s + b.high, 0)).toBe(p.estimate.session_tokens.high);
    const small = estimateSession(2_000, 1_000);
    const big = estimateSession(20_000, 1_000);
    expect(big.low).toBeGreaterThan(small.low);
    expect(p.estimate.seconds).toBeGreaterThanOrEqual(2);
  });

  it("formatPlan mostra grupos, aviso de nota E e a previsão", () => {
    const r = makeRepo();
    r.write("README.md", "x");
    r.commit("feat: a");
    const text = formatPlan(plan({ root: r.root, rubricPath: RUBRIC_PATH }));
    expect(text).toContain("[x] security");
    expect(text).toContain("a nota será E por cobertura insuficiente");
    expect(text).toMatch(/medição 0 tokens · conversa ≈ [\d.]+–[\d.]+ tokens/);
  });
});
