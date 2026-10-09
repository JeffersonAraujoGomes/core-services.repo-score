import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.js";
import { enabledGroups, resetUserEnabled, resolveSelection, setUserEnabled, skillConfigPath, userConfigPath } from "../src/groups-config.js";
import { formatPlan, plan } from "../src/plan.js";
import { cleanupFixtures, makeRepo } from "./fixture-repo.js";
import { loadRubric, RUBRIC_PATH } from "./helpers.js";

const rubric = loadRubric();
const KEYS = ["REPO_SCORE_ENABLED_GROUPS", "REPO_SCORE_HOME"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
let home: string;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = mkdtempSync(path.join(tmpdir(), "rs-cfg-"));
  process.env["REPO_SCORE_HOME"] = home;
  delete process.env["REPO_SCORE_ENABLED_GROUPS"]; // a config REAL (padrão da skill), não o "all" dos demais testes
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(home, { recursive: true, force: true });
});
afterAll(cleanupFixtures);

describe("grupos ativados", () => {
  it("o padrão entregue com a skill ativa só Documentação", () => {
    const g = enabledGroups(rubric);
    expect(g.enabled).toEqual(["documentation"]);
    expect(g.source).toBe("skill");
    expect(JSON.parse(readFileSync(skillConfigPath()!, "utf8")).enabled).toEqual(["documentation"]);
  });

  it("precedência: variável de ambiente > config do usuário > padrão da skill", () => {
    setUserEnabled(rubric, ["documentation", "security"]);
    expect(enabledGroups(rubric)).toMatchObject({ enabled: ["security", "documentation"], source: "user" });
    process.env["REPO_SCORE_ENABLED_GROUPS"] = "code";
    expect(enabledGroups(rubric)).toMatchObject({ enabled: ["code"], source: "env" });
    process.env["REPO_SCORE_ENABLED_GROUPS"] = "all";
    expect(enabledGroups(rubric).enabled).toHaveLength(7);
  });

  it("groups set grava a escolha, groups reset a remove e o padrão volta", () => {
    const file = setUserEnabled(rubric, ["all"]);
    expect(file).toBe(userConfigPath());
    expect(enabledGroups(rubric).enabled).toHaveLength(7);
    expect(resetUserEnabled()).toBe(true);
    expect(enabledGroups(rubric)).toMatchObject({ enabled: ["documentation"], source: "skill" });
    expect(resetUserEnabled()).toBe(true); // o arquivo continua existindo, sem a chave
    rmSync(file);
    expect(resetUserEnabled()).toBe(false);
  });

  it("recusa ids desconhecidos em qualquer origem e preserva outras chaves do config do usuário", () => {
    expect(() => setUserEnabled(rubric, ["seguranca"])).toThrow(/grupo desconhecido seguranca/);
    process.env["REPO_SCORE_ENABLED_GROUPS"] = "documentation,xyz";
    expect(() => enabledGroups(rubric)).toThrow(/xyz/);
    delete process.env["REPO_SCORE_ENABLED_GROUPS"];
    writeFileSync(userConfigPath(), JSON.stringify({ outra: 1 }));
    setUserEnabled(rubric, ["code"]);
    expect(JSON.parse(readFileSync(userConfigPath(), "utf8"))).toEqual({ outra: 1, enabled_groups: ["code"] });
  });
});

describe("escolha na análise", () => {
  it("sem pedido, avalia todos os ativados; pedir um desativado falha dizendo como ativar", () => {
    expect(resolveSelection(rubric).selected).toEqual(["documentation"]);
    expect(resolveSelection(rubric, ["documentation"]).selected).toEqual(["documentation"]);
    expect(() => resolveSelection(rubric, ["security"])).toThrow(/grupo desativado: security.*groups set documentation,security/);
    expect(() => resolveSelection(rubric, ["nada"])).toThrow(/grupo desconhecido/);
    setUserEnabled(rubric, ["documentation", "security"]);
    expect(resolveSelection(rubric, ["security"]).selected).toEqual(["security"]);
  });

  it("analyze sem --groups mede só Documentação; os demais ficam fora e aparecem como desativados", async () => {
    const r = makeRepo();
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.commit("feat: a");
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: path.join(home, "out") });
    expect(data.meta.selected_groups).toEqual(["documentation"]);
    expect(data.meta.enabled_groups).toEqual(["documentation"]);
    expect(data.meta.enabled_source).toBe("skill");
    const withScore = Object.values(data.result.dimensions).filter((d) => d.score_pct !== null).map((d) => d.id);
    expect(withScore).toEqual(["documentation"]);
    // nenhum coletor de outro grupo foi executado: nada de S2, P4 etc. medido
    expect(Object.values(data.result.dimensions).flatMap((d) => d.criteria).filter((c) => c.state === "scored" && !c.id.startsWith("D"))).toEqual([]);
  });

  it("analyze pedindo grupo desativado é recusado antes de qualquer trabalho", async () => {
    const r = makeRepo();
    r.write("README.md", "# P");
    await expect(analyze({ root: r.root, rubricPath: RUBRIC_PATH, groups: ["security"], outDir: path.join(home, "o") })).rejects.toThrow(/grupo desativado/);
    expect(existsSync(path.join(home, "o"))).toBe(false);
  });

  it("depois de ativar, o grupo pode ser escolhido e medido junto", async () => {
    setUserEnabled(rubric, ["documentation", "process"]);
    const r = makeRepo();
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.write(".github/CODEOWNERS", "* @org/a\n/x @org/b\n/y @org/c\n");
    r.commit("feat: a");
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: path.join(home, "o2") });
    expect(data.meta.selected_groups).toEqual(["documentation", "process"]);
    expect(data.result.dimensions["process"]!.criteria.find((c) => c.id === "P6")).toMatchObject({ state: "scored", points: 2 });
  });
});

describe("plan e skill", () => {
  it("plan marca os grupos desativados e só os ativados vêm selecionados", () => {
    const r = makeRepo();
    r.write("README.md", "# P");
    r.commit("feat: a");
    const p = plan({ root: r.root, rubricPath: RUBRIC_PATH });
    expect(p.groups.filter((g) => g.enabled).map((g) => g.id)).toEqual(["documentation"]);
    expect(p.groups.filter((g) => g.selected).map((g) => g.id)).toEqual(["documentation"]);
    expect(p.enabled_groups).toMatchObject({ groups: ["documentation"], source: "skill" });
    const text = formatPlan(p);
    expect(text).toContain("[x] documentation");
    expect(text).toContain("security — Segurança (peso 20): 13 critérios, 5 com medição automática · DESATIVADO");
    expect(text).toContain("repo-score groups set");
  });

  it("plan com grupo desativado falha com a mesma orientação", () => {
    const r = makeRepo();
    r.write("README.md", "# P");
    expect(() => plan({ root: r.root, rubricPath: RUBRIC_PATH, groups: ["code"] })).toThrow(/grupo desativado: code/);
  });
});
