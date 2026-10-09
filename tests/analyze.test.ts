import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze, persist } from "../src/analyze.js";
import { renderReport, safeJson } from "../src/report/render.js";
import { cleanupFixtures, makeRepo } from "./fixture-repo.js";
import { RUBRIC_PATH } from "./helpers.js";

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

describe("analyze (ponta a ponta)", () => {
  it("mede, aplica o gate de S1, verifica evidências e gera o relatório", async () => {
    const r = makeRepo();
    r.write("App/appsettings.json", `{\n  "Password": "${["pa", "ss", "w0rd"].join("")}",\n  "ApiKey": "${["k3", "y", "Value"].join("")}"\n}\n`);
    r.write("Dockerfile", "FROM node:latest\n");
    r.commit("feat: initial");
    const out = home();

    const { data, outDir } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    expect(data.result.blocked_by).toEqual(["S1"]);
    expect(data.result.grade).not.toBeNull();
    expect(data.result.coverage.measured).toBeLessThan(data.result.coverage.applicable);
    expect(data.final).toMatchObject({ grade: "E", reason: "insufficient_coverage" }); // cobertura da v0 < 50% do peso
    expect(data.result.unmeasured.some((u) => u.reason === data.meta.not_implemented_reason)).toBe(true);
    expect(data.evidence_issues).toEqual([]); // toda evidência produzida pelos coletores confere com o repo
    expect(data.opportunities[0]).toMatchObject({ id: "S1", unblocks_gate: true });
    expect(data.meta.branch).toBe("main");

    const files = persist(outDir, data, renderReport(data));
    expect(readdirSync(out)).toEqual(expect.arrayContaining(["latest.json", "report.html"]));
    expect(readFileSync(files.html, "utf8")).toContain("<!doctype html>");
  });

  it("não grava nada dentro do repo analisado", async () => {
    const r = makeRepo();
    r.write("a.txt", "x");
    r.commit("feat: a");
    const before = r.git("status", "--porcelain");
    const out = home();
    const { data, outDir } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    persist(outDir, data, renderReport(data));
    expect(r.git("status", "--porcelain")).toBe(before);
  });

  it("compara com a análise anterior (histórico em latest.json)", async () => {
    const r = makeRepo();
    r.write("App/appsettings.json", `{\n  "Password": "${["pa", "ss", "w0rd"].join("")}",\n  "ApiKey": "${["k3", "y", "Value"].join("")}"\n}\n`);
    r.commit("feat: a");
    const out = home();
    const first = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    expect(first.data.comparison.status).toBe("no_baseline");
    persist(out, first.data, renderReport(first.data));

    r.write("App/appsettings.json", `{ "Password": "" }\n`);
    r.commit("fix: remove secret");
    const second = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: out });
    expect(second.data.result.blocked_by).toEqual([]);
    expect(second.data.comparison).toMatchObject({ status: "ok" });
    expect((second.data.comparison as { delta: number }).delta).toBeGreaterThan(0);
  });

  it("falha com mensagem clara se o diretório não existe", async () => {
    await expect(analyze({ root: "/nao/existe/mesmo", rubricPath: RUBRIC_PATH })).rejects.toThrow(/diretório não encontrado/);
  });

  it("um coletor que quebra vira unmeasured, sem derrubar a análise", async () => {
    const r = makeRepo({ git: false });
    r.write("a.txt", "x");
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: home() });
    const s2 = data.result.unmeasured.find((u) => u.id === "S2");
    expect(s2?.reason).toMatch(/não é um repositório git/);
  });
});

describe("relatório HTML", () => {
  it("escapa </script>, <!-- e separadores de linha vindos de evidências do repo", () => {
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const hostile = `</script><script>alert(1)</script><!-- ${LS} ${PS} $& $1`;
    const json = safeJson({ note: hostile });
    expect(json).not.toContain("</script>");
    expect(json).not.toContain("<!--");
    expect(json.includes(LS) || json.includes(PS)).toBe(false);
    expect(JSON.parse(json).note).toBe(hostile); // round-trip íntegro
  });

  it("embute os dados sem interpretar padrões de replace ($&, $1)", async () => {
    const r = makeRepo();
    r.write("weird $& name.json", `{ "Password": "${["pa", "ss", "w0rd"].join("")}" }\n`);
    // nome de arquivo hostil: só o caminho vai para o relatório, nunca o valor do segredo
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: home() });
    const html = renderReport(data);
    const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!).meta.repo).toBe(data.meta.repo);
    expect(html).not.toContain("__REPORT_DATA__");
  });

  it("o template só usa textContent para dados do repo (sem innerHTML)", () => {
    const html = renderReport({ meta: {}, result: {}, criteria: {} } as never);
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("cabeçalho do relatório", () => {
  it("traz a tabela de composição da nota (dimensão, peso, participou, critérios, score, peso × score, total)", async () => {
    const r = makeRepo();
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.commit("feat: a");
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: home(), groups: ["documentation"] });
    const html = renderReport(data);
    for (const label of ["Composição da nota", "Participou da medição?", "Critérios que entraram", "Peso × score", "fora do escopo escolhido"]) expect(html).toContain(label);
    // os dados que a tabela usa: só as dimensões do escopo têm score
    const participated = Object.values(data.result.dimensions).filter((d) => d.score_pct !== null).map((d) => d.id);
    expect(participated).toEqual(["documentation"]);
    const sumWS = Object.values(data.result.dimensions).reduce((a, d) => a + (d.score_pct === null ? 0 : d.weight * d.score_pct), 0);
    const sumW = Object.values(data.result.dimensions).reduce((a, d) => a + (d.score_pct === null ? 0 : d.weight), 0);
    expect(data.result.total).toBeCloseTo(sumWS / sumW, 9); // o total exibido é exatamente o da tabela
  });
});
