import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze } from "../../src/analyze.js";
import { formatLint, lintSpecs } from "../../src/groups/documentation/sdd/discovery/lint.js";
import { classifyDoc } from "../../src/groups/documentation/sdd/discovery/inventory.js";
import { buildSpecPlan, plannedSiblings } from "../../src/groups/documentation/sdd/discovery/plan.js";
import { formatSimulation, simulateSdd } from "../../src/groups/documentation/sdd/discovery/simulate.js";
import { forecastTokens, TOKEN_MODEL } from "../../src/groups/documentation/sdd/discovery/tokens.js";
import { classifyRuleFile } from "../../src/groups/documentation/shared/rule-files.js";
import { lintSpec, renderSpecSkeleton, SPEC_BLOCKS, SPEC_BUDGET } from "../../src/groups/documentation/sdd/spec-standard.js";
import { cleanupFixtures, makeRepo, type FixtureRepo } from "../fixture-repo.js";
import { RUBRIC_PATH } from "../helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

afterAll(cleanupFixtures);

/** Classe com lógica de negócio de verdade: ≥ 25 linhas e vários desvios/números. */
const ruleClass = (name: string, methods = 30) =>
  `public class ${name}\n{\n${Array.from({ length: methods }, (_, i) => `    public decimal Calc${name}${i}(decimal v) { if (v > ${i + 3}) { return v * ${i + 5}; } else if (v < ${i + 2}) { return ${i + 7}; } return v; }`).join("\n")}\n}\n`;

const GOOD_SPEC = `# 03.1 — Desconto

> Parte de: [03 — Visão](./03-visao.md)

## O que a regra faz

Aplica o desconto do contrato.

## Parâmetros

| Nome | Valor |
|------|-------|
| Limite | 90 dias |

## Contexto

Existe por causa da política X. ⚠️ Risco: depende de Y.

---

## Referências técnicas

> Cada linha começando com \`Arquivo:\` é lida pelo gate de commit.

Arquivo: src/Rules/Desconto.cs
`;

describe("padrão das specs (lint)", () => {
  it("uma spec conforme não tem erros nem avisos", () => {
    expect(lintSpec(GOOD_SPEC)).toEqual([]);
  });

  it("os 4 blocos são obrigatórios e na ordem do padrão", () => {
    expect(SPEC_BLOCKS).toEqual(["O que a regra faz", "Parâmetros", "Contexto", "Referências técnicas"]);
    const missing = GOOD_SPEC.replace(/## Contexto[\s\S]*?(?=---)/, "");
    expect(lintSpec(missing).map((i) => i.message)).toContain('falta o bloco "## Contexto"');
    const swapped = GOOD_SPEC.replace("## Parâmetros", "## TMP").replace("## Contexto", "## Parâmetros").replace("## TMP", "## Contexto");
    expect(lintSpec(swapped).some((i) => i.message.includes("ordem"))).toBe(true);
  });

  it("bloco vazio, sem ponteiro, ponteiro com linha, spec longa e TODO são erros", () => {
    expect(lintSpec(GOOD_SPEC.replace(/\| Nome[\s\S]*?90 dias \|/, "")).some((i) => i.rule === "bloco-vazio")).toBe(true);
    expect(lintSpec(GOOD_SPEC.replace("Arquivo: src/Rules/Desconto.cs", "")).some((i) => i.rule === "ponteiros")).toBe(true);
    expect(lintSpec(GOOD_SPEC.replace("Desconto.cs", "Desconto.cs:136")).some((i) => i.rule === "linha-no-ponteiro")).toBe(true);
    expect(lintSpec(GOOD_SPEC + "\nlinha de texto\n".repeat(SPEC_BUDGET.maxLines)).some((i) => i.rule === "tamanho" && i.level === "error")).toBe(true);
    expect(lintSpec(GOOD_SPEC.replace("política X", "TODO definir")).some((i) => i.rule === "pendencia")).toBe(true);
  });

  it("o esqueleto entregue às tarefas já tem os 4 blocos, o vínculo com a spec-mãe e os ponteiros", () => {
    const sk = renderSpecSkeleton({ id: "03.1", title: "Desconto", parent: { id: "03", title: "Visão", file: "03-visao.md" }, files: ["src/A.cs", "src/B.cs"] });
    for (const b of SPEC_BLOCKS) expect(sk).toContain(`## ${b}`);
    expect(sk).toContain("> Parte de: [03 — Visão](./03-visao.md)");
    expect(sk).toContain("Arquivo: src/A.cs\nArquivo: src/B.cs");
    expect(lintSpec(sk).filter((i) => i.level === "error")).toEqual([]);
  });

  it("a documentação do padrão (skill/references/spec-standard.md) cita os mesmos blocos e limites do código", () => {
    const doc = readFileSync(path.resolve(import.meta.dirname, "../../skill/references/spec-standard.md"), "utf8");
    for (const b of SPEC_BLOCKS) expect(doc).toContain(b);
    expect(doc).toContain(String(SPEC_BUDGET.maxLines));
    expect(doc).toContain(String(SPEC_BUDGET.targetLines));
  });

  it("aceita ponteiro no formato que o gate lê (`> \`Arquivo: x\``), com aviso de formato, sem acusar falta", () => {
    const legacy = GOOD_SPEC.replace("Arquivo: src/Rules/Desconto.cs", "> `Arquivo: src/Rules/Desconto.cs`");
    const issues = lintSpec(legacy);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.some((i) => i.level === "warn" && i.message.includes("início da linha"))).toBe(true);
  });

  it("lintSpecs confere ponteiros contra o repo e ignora os índices", () => {
    const r = makeRepo();
    r.write("src/Rules/Desconto.cs", "class D {}");
    r.write("docs/specs/README.md", "# Índice");
    r.write("docs/specs/03.1-BUS-desconto.md", GOOD_SPEC);
    r.write("docs/specs/03.2-BUS-ruim.md", GOOD_SPEC.replace("src/Rules/Desconto.cs", "src/Rules/Nao.cs"));
    const res = lintSpecs(r.ctx());
    expect(res.map((x) => path.basename(x.path))).toEqual(["03.1-BUS-desconto.md", "03.2-BUS-ruim.md"]);
    expect(res[0]!.issues).toEqual([]);
    expect(res[1]!.missingPointers).toEqual(["src/Rules/Nao.cs"]);
    expect(formatLint(res)).toContain("1 conformes · 0 com avisos · 1 com erros");
  });
});

describe("definição única de arquivo de regra", () => {
  it("aceita lógica de negócio e recusa infraestrutura, gerado, teste e trivial", () => {
    expect(classifyRuleFile("src/Domain/DiscountRule.cs", ruleClass("DiscountRule")).rule).toBe(true);
    expect(classifyRuleFile("src/Program.cs", ruleClass("Program"))).toMatchObject({ rule: false, why: "infraestrutura" });
    expect(classifyRuleFile("src/Setup/ServiceCollectionExtensions.cs", ruleClass("X"))).toMatchObject({ rule: false, why: "infraestrutura" });
    expect(classifyRuleFile("src/Avro/EventHeader.cs", ruleClass("EventHeader"))).toMatchObject({ rule: false, why: "infraestrutura" });
    expect(classifyRuleFile("src/Events/Evt.cs", "// <auto-generated/>\n" + ruleClass("Evt"))).toMatchObject({ rule: false, why: "gerado" });
    expect(classifyRuleFile("src/Api.IntegrationTest/PayTests.cs", ruleClass("PayTests"))).toMatchObject({ rule: false, why: "caminho" });
    expect(classifyRuleFile("src/Domain/Dto/PayDto.cs", ruleClass("PayDto"))).toMatchObject({ rule: false, why: "caminho" });
    expect(classifyRuleFile("src/Desktop/MainWindow.cs", ruleClass("MainWindow"))).toMatchObject({ rule: false, why: "infraestrutura" });
    expect(classifyRuleFile("src/Domain/Enums/ProductEnum.cs", ruleClass("ProductEnum"))).toMatchObject({ rule: false, why: "glossario" });
    expect(classifyRuleFile("src/Domain/Trivial.cs", "class Trivial { }")).toMatchObject({ rule: false, why: "baixa-densidade" });
  });
});

describe("inventário de documentos", () => {
  it("converte documentos de regra e descarta convenção e guias técnicos", () => {
    const rules = "# Regras de juros\n\nA taxa de juros deve ser aplicada quando o atraso passar do prazo. Nunca cobrar juros sobre o saldo pago. Se houver atraso então calcular a fórmula VP = VM / (1 + r)^n. ".repeat(6);
    expect(classifyDoc("docs/REGRAS.md", rules)).toMatchObject({ convertible: true, signal: "alto" });
    expect(classifyDoc("README.md", rules).convertible).toBe(false);
    expect(classifyDoc("docs/OPENTELEMETRY_IMPLEMENTATION.md", "# Telemetria\nComo instalar o pacote e configurar o exporter.").convertible).toBe(false);
    expect(classifyDoc("docs/FLUXO.md", "# Fluxograma\n```mermaid\nflowchart TD\n A-->B\n```\nSe saldo vencido então apropriar juros.").kind).toBe("fluxo");
  });
});

/** Monorepo sem SDD: 2 apps, regras em handlers, arquivo grande, infraestrutura, gerado, teste e documentos. */
function noSddRepo(): FixtureRepo {
  const r = makeRepo();
  r.write("apps.yml", "apps:\n  - dir: pay\n  - dir: notify\n");
  r.write("README.md", "# Monorepo\nVisão do produto.");
  r.write("apps/pay/Dockerfile", "FROM scratch");
  r.write("apps/notify/Dockerfile", "FROM scratch");
  r.write("apps/pay/Pay.Domain/Handlers/SettleHandler.cs", ruleClass("SettleHandler"));
  r.write("apps/pay/Pay.Domain/Handlers/RefundHandler.cs", ruleClass("RefundHandler"));
  r.write("apps/pay/Pay.Domain/Handlers/GiantHandler.cs", ruleClass("GiantHandler", 800)); // arquivo grande: deve ser dividido
  r.write("apps/pay/Pay.Domain/Rules/DiscountRule.cs", ruleClass("DiscountRule"));
  r.write("apps/pay/Pay.Domain/Enums/Status.cs", "public enum Status { Open = 1, Paid = 2 }");
  r.write("apps/pay/Pay.Worker/Program.cs", ruleClass("Program"));
  r.write("apps/pay/Pay.Domain/Avro/EventHeader.cs", ruleClass("EventHeader"));
  r.write("apps/pay/Pay.IntegrationTest/PayTests.cs", ruleClass("PayTests"));
  r.write("apps/notify/Notify.Domain/Services/SendService.cs", ruleClass("SendService"));
  r.write(
    "apps/pay/docs/REGRAS_DE_BAIXA.md",
    "# Regras de baixa\n\nO `SettleHandler` deve baixar a parcela quando o saldo vencido for maior que o limite. Nunca baixar parcela cancelada.\n\n" + "Se houver atraso então calcular juros pela taxa e pelo prazo; a regra de provisão deve respeitar o limite. ".repeat(4),
  );
  r.write("apps/pay/docs/ANALISE_GRANDE.md", ("## Seção X\n\nA regra de cálculo de juros e provisão deve considerar o saldo vencido e o prazo; nunca ignorar o atraso. Se houver atraso então calcular a taxa. ".repeat(40) + "\n\n").replace(/## Seção X/g, (m, o: number) => `## Seção ${o}`));
  r.write("apps/pay/docs/GUIA_INSTALACAO.md", "# Guia\nComo instalar o pacote e configurar o ambiente de desenvolvimento.");
  r.commit("feat: inicial");
  return r;
}

describe("plano de specs", () => {
  it("cobre só regra de negócio: infraestrutura, gerado, teste e trivial ficam de fora", () => {
    const r = noSddRepo();
    const plan = buildSpecPlan(r.ctx());
    const pointers = plan.specs.flatMap((s) => s.pointers);
    for (const bad of ["Program.cs", "EventHeader.cs", "PayTests.cs"]) expect(pointers.some((p) => p.endsWith(bad))).toBe(false);
    for (const good of ["SettleHandler.cs", "RefundHandler.cs", "DiscountRule.cs", "SendService.cs"]) expect(pointers.some((p) => p.endsWith(good))).toBe(true);
    expect(plan.stats.plumbingSkipped).toBeGreaterThanOrEqual(2);
  });

  it("segue o orçamento: ids e arquivos únicos, ponteiros em todas as specs de código e ≤ 4 por spec de regra", () => {
    const plan = buildSpecPlan(noSddRepo().ctx());
    expect(new Set(plan.specs.map((s) => s.id)).size).toBe(plan.specs.length);
    expect(new Set(plan.specs.map((s) => s.file)).size).toBe(plan.specs.length);
    for (const s of plan.specs.filter((x) => x.kind === "regra" || x.kind === "orquestracao")) expect(s.pointers.length).toBeGreaterThan(0);
    for (const s of plan.specs.filter((x) => x.kind === "regra")) expect(s.pointers.length).toBeLessThanOrEqual(SPEC_BUDGET.maxPointers);
    expect(plan.specs.map((s) => s.id).slice(0, 2)).toEqual(["00", "01"]); // visão geral e glossário (enums)
    expect(plan.specs.find((s) => s.kind === "glossario")!.pointers).toEqual(["apps/pay/Pay.Domain/Enums/Status.cs"]);
  });

  it("arquivo grande vira várias specs pequenas, cada uma com seu recorte (nunca uma spec gigante)", () => {
    const plan = buildSpecPlan(noSddRepo().ctx());
    const parts = plan.specs.filter((s) => s.kind === "regra" && s.pointers.includes("apps/pay/Pay.Domain/Handlers/GiantHandler.cs"));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of parts) {
      expect(p.subtopic).toMatch(/^parte \d+ de \d+/);
      expect(p.codeLines).toBeLessThanOrEqual(SPEC_BUDGET.splitCodeLines + 50);
    }
  });

  it("documento convertido: um por spec de código; os demais viram specs próprias; documento grande é quebrado por seções; guia é descartado", () => {
    const plan = buildSpecPlan(noSddRepo().ctx());
    const baixa = plan.docs.find((d) => d.path.endsWith("REGRAS_DE_BAIXA.md"))!;
    expect(baixa.convertible).toBe(true);
    const absorbing = plan.specs.find((s) => s.sourceDocs.includes("apps/pay/docs/REGRAS_DE_BAIXA.md"))!;
    expect(absorbing.pointers.some((p) => p.endsWith("SettleHandler.cs"))).toBe(true);
    expect(plan.specs.filter((s) => s.kind === "regra").every((s) => s.sourceDocs.length <= 1)).toBe(true);
    const big = plan.specs.filter((s) => s.sourceDocs.includes("apps/pay/docs/ANALISE_GRANDE.md"));
    expect(big.length).toBeGreaterThanOrEqual(2);
    expect(big.every((s) => s.kind === "convertida" && s.subtopic)).toBe(true);
    expect(plan.docs.find((d) => d.path.endsWith("GUIA_INSTALACAO.md"))!.convertible).toBe(false);
  });

  it("o perímetro derivado do plano cobre as pastas das regras e a projeção de D7 é coerente com ele", () => {
    const r = noSddRepo();
    const plan = buildSpecPlan(r.ctx());
    expect(plan.globs.length).toBeGreaterThan(0);
    expect(plan.globs.every((g) => g.endsWith("/*"))).toBe(true);
    const { linked, siblings } = plannedSiblings(r.ctx(), plan);
    expect(linked.length).toBeGreaterThanOrEqual(5);
    expect(siblings).toEqual([]); // tudo o que é regra nessas pastas está no plano
  });

  it("estoura o orçamento: mantém visão geral, glossário e orquestração e adia as de menor densidade", () => {
    const plan = buildSpecPlan(noSddRepo().ctx(), { maxSpecs: 6 });
    expect(plan.specs.length).toBe(6);
    expect(plan.deferred.length).toBeGreaterThan(0);
    expect(plan.specs.filter((s) => ["visao-geral", "glossario", "orquestracao"].includes(s.kind)).length).toBeGreaterThanOrEqual(4);
  });
});

describe("previsão de tokens", () => {
  it("é crescente com o tamanho do plano, tem faixa e conta a partida fria dos lotes", () => {
    const r = noSddRepo();
    const small = forecastTokens(buildSpecPlan(r.ctx(), { maxSpecs: 6 }));
    const full = forecastTokens(buildSpecPlan(r.ctx()));
    expect(full.mid).toBeGreaterThan(small.mid);
    expect(full.low).toBeLessThan(full.mid);
    expect(full.high).toBeGreaterThan(full.mid);
    expect(full.batches).toBeGreaterThanOrEqual(small.batches);
    expect(full.breakdown.find((b) => b.item.includes("Partida fria"))!.tokens).toBe(full.batches * TOKEN_MODEL.coldStartPerBatch);
    expect(full.breakdown.reduce((a, b) => a + b.tokens, 0)).toBeGreaterThanOrEqual(full.low);
    expect(full.basis).toContain("calibrado");
  });
});

/** Fotografia do disco (caminho, tamanho e mtime), para provar que a simulação não escreve nada. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === ".git") continue;
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
}

describe("simulação do fluxo (só leitura)", () => {
  async function simulate(r: FixtureRepo) {
    const base = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, groups: ["documentation"], outDir: mkdtempSync(path.join(tmpdir(), "rs-sim-")) });
    return simulateSdd(r.ctx(), { rubric: base.rubric, input: base.input, result: base.data.result, meta: { repo: base.data.meta.repo, branch: base.data.meta.branch, commit: base.data.meta.commit } });
  }

  it("não cria nem altera nada no repo: nem arquivo, nem branch, nem commit", async () => {
    const r = noSddRepo();
    const before = snapshot(r.root);
    const head = r.git("rev-parse", "HEAD").trim();
    const branches = r.git("branch", "--list");
    const report = await simulate(r);
    formatSimulation(report);
    expect(snapshot(r.root)).toEqual(before);
    expect(r.git("status", "--porcelain").trim()).toBe("");
    expect(r.git("rev-parse", "HEAD").trim()).toBe(head);
    expect(r.git("branch", "--list")).toBe(branches);
  });

  it("detecta SDD pela pasta docs/specs na raiz, com o motivo certo para cada situação", async () => {
    const zero = makeRepo();
    zero.write("src/Rules/R.cs", ruleClass("R"));
    zero.commit("feat: a");
    expect((await simulate(zero)).detection).toMatchObject({ sddPresent: false, docsDirExists: false, reason: expect.stringContaining("nem docs/ existe") });

    const semSpecs = noSddRepo();
    semSpecs.write("docs/README.md", "# Docs");
    semSpecs.commit("docs: a");
    expect((await simulate(semSpecs)).detection).toMatchObject({ sddPresent: false, docsDirExists: true, reason: expect.stringContaining("docs/specs não") });

    const comSdd = noSddRepo();
    comSdd.write("docs/specs/00-visao.md", "# 00");
    comSdd.commit("docs: specs");
    expect((await simulate(comSdd)).detection).toMatchObject({ sddPresent: true });
  });

  it("repo sem a pasta docs: mostra os guardrails a criar, o custo e a projeção da nota", async () => {
    const r = noSddRepo();
    const report = await simulate(r);
    const paths = report.guardrails.map((g) => g.path);
    for (const p of [".sdd/manifest.json", ".githooks/pre-commit", ".githooks/sdd-analyze", ".githooks/post-commit", ".githooks/pre-push", ".claude/hooks/spec-change-guard.sh", ".claude/settings.json", "docs/specs/README.md"]) expect(paths).toContain(p);
    expect(report.guardrails.find((g) => g.path === ".githooks/pre-commit")!.mode).toContain("executável");
    expect(report.forecast.mid).toBeGreaterThan(0);
    const [sddOnly, all] = report.projections;
    expect(sddOnly!.criteria["D7"]).toBe(2);
    expect(sddOnly!.total!).toBeGreaterThan(report.baseline.total!);
    expect(all!.total!).toBeGreaterThanOrEqual(sddOnly!.total!);
    expect(report.journey.map((j) => j.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("o texto mostra os 8 passos com indicadores, o esqueleto e a previsão antes de qualquer escrita", async () => {
    const text = formatSimulation(await simulate(noSddRepo()));
    for (const t of ["SIMULAÇÃO DO SDD — nada foi criado", "1/8 [●]", "6/8 [?]", "7/8 [◆]", "PREVISÃO DE TOKENS", "ESQUELETO QUE CADA TAREFA RECEBE", "JORNADA NA SKILL", "## O que a regra faz", "SDD AUSENTE"]) expect(text).toContain(t);
  });
});

void execFileSync;
