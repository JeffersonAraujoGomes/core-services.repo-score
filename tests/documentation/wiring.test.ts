import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSpecPlan } from "../../src/groups/documentation/sdd/discovery/plan.js";
import { forecastTokens } from "../../src/groups/documentation/sdd/discovery/tokens.js";
import { planSdd } from "../../src/groups/documentation/sdd/scaffold.js";
import { SPEC_BUDGET } from "../../src/groups/documentation/sdd/spec-standard.js";
import { finishFix, previewFixes, sealFix, startFix } from "../../src/remediation/engine.js";
import { formatPreview, formatSeal } from "../../src/remediation/format.js";
import { cleanupFixtures, makeRepo, type FixtureRepo } from "../fixture-repo.js";
import { RUBRIC_PATH } from "../helpers.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "rs-wire-"));
  process.env["REPO_SCORE_HOME"] = home;
});
afterAll(() => {
  cleanupFixtures();
  rmSync(home, { recursive: true, force: true });
});

const rule = (n: string, methods = 30) => `public class ${n}\n{\n${Array.from({ length: methods }, (_, i) => `    public int M${n}${i}(int v) { if (v > ${i + 3}) { return v * ${i + 5}; } else if (v < ${i + 2}) { return ${i + 7}; } return v; }`).join("\n")}\n}\n`;

const std = (title: string, files: string[], parent?: string) =>
  `# ${title}\n\n${parent ? `> Parte de: [${parent}](./${parent})\n\n` : ""}## O que a regra faz\n\nDescreve o comportamento atual da regra, em linguagem de negócio.\n\n## Parâmetros\n\nSem parâmetros: nenhum valor configurável.\n\n## Contexto\n\nExiste pela política interna; nada frágil encontrado.\n\n---\n\n## Referências técnicas\n\n${files.map((f) => `Arquivo: ${f}`).join("\n")}\n`;

/** Repo sem docs/: 2 apps, 10 handlers com regra, um documento de negócio. */
function noDocsRepo(handlers = 10): FixtureRepo {
  const r = makeRepo();
  r.write("apps.yml", "apps:\n  - dir: pay\n");
  r.write("README.md", "# Monorepo\nVisão do produto, com texto suficiente.");
  r.write("apps/pay/Dockerfile", "FROM scratch");
  for (let i = 0; i < handlers; i++) r.write(`apps/pay/Pay.Domain/Handlers/H${i}Handler.cs`, rule(`H${i}Handler`));
  r.write("apps/pay/Pay.Worker/Program.cs", rule("Program"));
  r.write("apps/pay/docs/REGRAS.md", "# Regras de baixa\n\nO `H0Handler` deve baixar a parcela quando o saldo vencido passar do limite. Nunca baixar parcela cancelada. Se houver atraso então calcular juros pela taxa e pelo prazo; a regra deve respeitar o limite. ".repeat(4));
  r.commit("feat: inicial");
  return r;
}

describe("plano → tarefas guiadas da adoção", () => {
  it("lotes de até 6 specs, cada spec do plano em exatamente um lote, depois visão geral/índice e skill", () => {
    const r = noDocsRepo();
    const plan = buildSpecPlan(r.ctx());
    const result = planSdd(r.ctx(), {})!;
    const ids = result.guided.map((g) => g.id);
    expect(ids.filter((i) => i.startsWith("sdd-specs:")).length).toBe(Math.ceil(plan.specs.filter((s) => !["visao-geral", "glossario"].includes(s.kind)).length / SPEC_BUDGET.specsPerBatch));
    expect(ids.slice(-2)).toEqual(["sdd-overview", "sdd-skill"]);
    const targeted = result.guided.filter((g) => g.id.startsWith("sdd-specs:")).flatMap((g) => g.targets);
    expect(new Set(targeted).size).toBe(targeted.length); // sem spec duplicada entre lotes
    for (const s of plan.specs.filter((x) => !["visao-geral", "glossario"].includes(x.kind))) expect(targeted).toContain(`docs/specs/${s.file}`);
    for (const g of result.guided.filter((x) => x.id.startsWith("sdd-specs:"))) expect(g.targets.length).toBeLessThanOrEqual(SPEC_BUDGET.specsPerBatch);
  });

  it("cada briefing carrega o padrão, o esqueleto, os ponteiros e o documento a converter", () => {
    const r = noDocsRepo(3);
    const g = planSdd(r.ctx(), {})!.guided.find((x) => x.id === "sdd-specs:1")!;
    expect(g.instructions).toContain("## Padrão (obrigatório)");
    expect(g.instructions).toContain("Arquivo: apps/pay/Pay.Domain/Handlers/H0Handler.cs");
    expect(g.instructions).toContain("Documentos existentes a CONVERTER");
    expect(g.instructions).toContain("apps/pay/docs/REGRAS.md");
    expect(g.instructions).toContain("Spec-mãe:");
    expect(g.instructions).not.toContain("Program.cs"); // infraestrutura não entra
  });

  it("o perímetro do manifest sai do plano, e --param rule_globs o substitui", () => {
    const r = noDocsRepo(3);
    const manifest = planSdd(r.ctx(), {})!.changes.find((c) => c.path === ".sdd/manifest.json")!;
    expect(JSON.parse((manifest as { content: string }).content).ruleCodeGlobs).toEqual(buildSpecPlan(r.ctx()).globs);
    const custom = planSdd(r.ctx(), { rule_globs: "apps/pay/*" })!.changes.find((c) => c.path === ".sdd/manifest.json")!;
    expect(JSON.parse((custom as { content: string }).content).ruleCodeGlobs).toEqual(["apps/pay/*"]);
  });

  it("max_specs limita o plano, o número de lotes e avisa das adiadas", () => {
    const r = noDocsRepo(30); // handlers vizinhos se agrupam: 30 viram ~10 specs, mais de um lote
    const full = planSdd(r.ctx(), {})!;
    const lean = planSdd(r.ctx(), { max_specs: "5" })!;
    const count = (p: typeof full) => p.guided.filter((g) => g.id.startsWith("sdd-specs:")).flatMap((g) => g.targets).length;
    expect(count(lean)).toBeLessThan(count(full));
    expect(count(lean)).toBeLessThanOrEqual(5);
    expect(lean.notes.join(" ")).toContain("adiada");
  });

  it("a previsão de tokens do preview vem do plano e aparece na tela antes de aplicar", () => {
    const r = noDocsRepo();
    const item = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: {} })[0]!;
    const forecast = forecastTokens(buildSpecPlan(r.ctx()));
    expect(item.tokens).not.toBeNull();
    expect(item.tokens!.low).toBe(forecast.low);
    expect(item.tokens!.high).toBe(forecast.high);
    expect(formatPreview([item])).toContain("TOKENS (estimativa)");
  });
});

describe("fluxo completo: planejar → guardrails → specs no padrão → nota e lint na branch nova", () => {
  it("repo sem docs/ chega a D7 = 2 com todas as specs no padrão, sem alterar a branch de origem", async () => {
    const r = noDocsRepo();
    const origin = r.git("rev-parse", "HEAD").trim();
    const plan = buildSpecPlan(r.ctx());
    const state = await startFix({ root: r.root, rubricPath: RUBRIC_PATH, actionIds: ["sdd-adopt"], params: {}, groups: ["documentation"] });
    expect(state.base_commit).toBe(origin);
    expect(state.guided_tasks.length).toBeGreaterThanOrEqual(3);

    // simula o trabalho dos subagentes: cada spec do plano, no padrão, com seus ponteiros
    mkdirSync(path.join(r.root, "docs/specs"), { recursive: true });
    for (const s of plan.specs) {
      const parent = s.parent ? plan.specs.find((p) => p.id === s.parent)?.file : undefined;
      writeFileSync(path.join(r.root, "docs/specs", s.file), std(`${s.id} — ${s.title}`, s.pointers, parent));
    }
    writeFileSync(path.join(r.root, "docs/specs/README.md"), `# Specs\n\n${plan.specs.map((s) => `- [${s.title}](./${s.file})`).join("\n")}\n`);

    const sealed = await sealFix({ root: r.root, rubricPath: RUBRIC_PATH, skipHooks: true });
    expect(sealed.state.after!.criteria["D7"]).toBe(2);
    expect(sealed.state.baseline.criteria["D7"]).toBe(0); // sem SDD, a ausência de spec é a medição (antes: "não medido" e fora do cálculo)
    const lint = sealed.data.panels.flatMap((p) => p.items).find((i) => i.label === "Padrão das specs")!;
    expect(lint.status).toBe("ok");
    expect(lint.detail).toContain(`${plan.specs.length} de ${plan.specs.length} conformes`);
    expect(formatSeal(sealed)).toContain("✓ Padrão das specs");
    expect(r.git("rev-parse", "main").trim()).toBe(origin);
    finishFix({ root: r.root, decision: "keep" });
  });

  it("spec fora do padrão aparece no seal como erro, e o merge segue sendo decisão do usuário", async () => {
    const r = noDocsRepo(3);
    await startFix({ root: r.root, rubricPath: RUBRIC_PATH, actionIds: ["sdd-adopt"], params: {}, groups: ["documentation"] });
    const plan = buildSpecPlan(r.ctx());
    const first = plan.specs.find((s) => s.kind === "regra")!;
    writeFileSync(path.join(r.root, "docs/specs", first.file), "# Sem blocos\n\nTexto solto, sem o padrão nem ponteiros.\n");
    const sealed = await sealFix({ root: r.root, rubricPath: RUBRIC_PATH, skipHooks: true });
    const lint = sealed.data.panels.flatMap((p) => p.items).find((i) => i.label === "Padrão das specs")!;
    expect(lint.status).toBe("fail");
    expect(formatSeal(sealed)).toContain("✕ Padrão das specs");
    expect(sealed.state.status).toBe("sealed");
  });
});

describe("migração das specs legadas ao padrão", () => {
  function legacyRepo(): FixtureRepo {
    const r = makeRepo();
    r.write(".sdd/manifest.json", JSON.stringify({ version: 1, projectName: "p", specsDir: "docs/specs", skillSlug: "sdd-p", skillPath: ".claude/skills/sdd-p/SKILL.md", ruleCodeGlobs: ["src/Rules/*"] }));
    r.write(".claude/skills/sdd-p/SKILL.md", "---\nname: sdd-p\n---\nSkill preenchida pelo time.\n");
    r.write("src/Rules/A.cs", rule("A"));
    r.write("README.md", "# P\nTexto suficiente do README do projeto.");
    r.write("docs/specs/README.md", "# Specs\n[1](01-legada.md)\n[2](02-BUS-ok.md)");
    r.write("docs/specs/01-legada.md", "# 01 — Legada\n\nTexto solto com a regra de A.\n\nArquivo: src/Rules/A.cs\n" + "linha de regra detalhada\n".repeat(150));
    r.write("docs/specs/02-BUS-ok.md", std("02 — Ok", ["src/Rules/A.cs"]));
    r.commit("feat: specs");
    return r;
  }

  it("só as specs fora do padrão viram tarefas de migração, em lotes, com o que o verificador apontou", () => {
    const r = legacyRepo();
    const t = planSdd(r.ctx(), {})!.guided.filter((g) => g.id.startsWith("sdd-migrate:"));
    expect(t).toHaveLength(1);
    expect(t[0]!.instructions).toContain("docs/specs/01-legada.md");
    expect(t[0]!.instructions).not.toContain("02-BUS-ok.md");
    expect(t[0]!.instructions).toContain('falta o bloco "## O que a regra faz"');
    expect(t[0]!.instructions).toContain("Acima do limite");
    expect(t[0]!.instructions).toContain("SEM perder regra");
  });

  it("migrate=none ignora; specs conformes não geram tarefa; a previsão inclui a migração", () => {
    const r = legacyRepo();
    expect(planSdd(r.ctx(), { migrate: "none" })!.guided.filter((g) => g.id.startsWith("sdd-migrate:"))).toEqual([]);
    const item = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: {} })[0]!;
    expect(item.tokens!.basis).toContain("fora do padrão");
    rmSync(path.join(r.root, "docs/specs/01-legada.md")); // migrar = reescrever no padrão e renomear com a marcação
    r.write("docs/specs/01-BUS-legada.md", std("01 — Legada", ["src/Rules/A.cs"]));
    r.commit("docs: migra");
    expect(planSdd(r.ctx(), {})?.guided.filter((g) => g.id.startsWith("sdd-migrate:")) ?? []).toEqual([]);
  });

  it("migrar na branch nova leva o painel de 'padrão' de erro para conforme", async () => {
    const r = legacyRepo();
    await startFix({ root: r.root, rubricPath: RUBRIC_PATH, actionIds: ["sdd-adopt"], params: {}, groups: ["documentation"] });
    rmSync(path.join(r.root, "docs/specs/01-legada.md"));
    writeFileSync(path.join(r.root, "docs/specs/01-BUS-legada.md"), std("01 — Legada", ["src/Rules/A.cs"]));
    const sealed = await sealFix({ root: r.root, rubricPath: RUBRIC_PATH, skipHooks: true });
    const lint = sealed.data.panels.flatMap((p) => p.items).find((i) => i.label === "Padrão das specs")!;
    expect(lint.status).toBe("ok");
    void readFileSync;
  });
});
