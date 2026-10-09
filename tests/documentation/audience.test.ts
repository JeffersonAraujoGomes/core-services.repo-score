import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../../src/analyze.js";
import { audienceFromName, audienceOfFile, audienceOfFiles } from "../../src/groups/documentation/sdd/audience.js";
import { lintSpecs } from "../../src/groups/documentation/sdd/discovery/lint.js";
import { buildSpecPlan } from "../../src/groups/documentation/sdd/discovery/plan.js";
import { lintSpec, renderSpecSkeleton, STANDARD_BRIEF, technicalTerms } from "../../src/groups/documentation/sdd/spec-standard.js";
import { planSdd } from "../../src/groups/documentation/sdd/scaffold.js";
import { sealFix, startFix } from "../../src/remediation/engine.js";
import { cleanupFixtures, makeRepo } from "../fixture-repo.js";
import { RUBRIC_PATH } from "../helpers.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "rs-aud-"));
  process.env["REPO_SCORE_HOME"] = home;
});
afterAll(() => {
  cleanupFixtures();
  rmSync(home, { recursive: true, force: true });
});

const rule = (n: string, methods = 30) => `public class ${n}\n{\n${Array.from({ length: methods }, (_, i) => `    public int M${n}${i}(int v) { if (v > ${i + 3}) { return v * ${i + 5}; } else if (v < ${i + 2}) { return ${i + 7}; } return v; }`).join("\n")}\n}\n`;

const spec = (what: string, aud: "BUS" | "ENG" = "BUS") =>
  `# 03.25 — [${aud}] Regra\n\n## O que a regra faz\n\n${what}\n\n## Parâmetros\n\nSem parâmetros: nada configurável.\n\n## Contexto\n\nExiste pela política interna.\n\n---\n\n## Referências técnicas\n\nArquivo: src/Rules/A.cs\n`;

describe("marcação BUS / ENG", () => {
  it("separa regra de negócio de componente técnico pelo nome e pelo caminho", () => {
    expect(audienceOfFile("apps/x/Domain/Rules/LossCureRule.cs")).toBe("BUS");
    expect(audienceOfFile("apps/x/Domain/Handlers/CreditImpairedRiskHandler.cs")).toBe("BUS");
    expect(audienceOfFile("apps/x/Domain/Services/CreditClientRiskService.cs")).toBe("BUS"); // "Client" no meio do nome é negócio
    expect(audienceOfFile("apps/x/Domain/Services/CalculateVencredRiskService.cs")).toBe("BUS");
    expect(audienceOfFile("apps/x/Domain/Services/BucketReader.cs")).toBe("ENG");
    expect(audienceOfFile("apps/x/Domain/Services/SendProvisionRiskService.cs")).toBe("ENG");
    expect(audienceOfFile("apps/x/Domain/Services/FileProcessingTracker.cs")).toBe("ENG");
    expect(audienceOfFile("apps/x/Rating.Infra.Data/Repositories/CreditOperationRiskRepository.cs")).toBe("ENG");
    expect(audienceOfFile("apps/x/Rating.Worker/Workers/LossWorker.cs")).toBe("ENG");
    expect(audienceOfFile("apps/x/Domain/Clients/DockClient.cs")).toBe("ENG"); // "Client" fechando o nome é cliente HTTP
    expect(audienceOfFiles(["a/LossRule.cs", "a/BucketReader.cs"])).toBe("BUS"); // empate = negócio
    expect(audienceOfFiles(["a/BucketReader.cs", "a/X/FooRepository.cs", "a/LossRule.cs"])).toBe("ENG");
  });

  it("o plano põe a marcação no nome do arquivo e no esqueleto, e nunca mistura os dois públicos numa spec", () => {
    const r = makeRepo();
    r.write("apps.yml", "apps:\n  - dir: pay\n");
    r.write("README.md", "# M\nVisão.");
    r.write("apps/pay/Dockerfile", "FROM scratch");
    for (const n of ["LossCureRule", "ArrearRule", "DiscountRule"]) r.write(`apps/pay/Pay.Domain/Rules/${n}.cs`, rule(n));
    for (const n of ["BucketReader", "PayRepository"]) r.write(`apps/pay/Pay.Domain/Services/${n}.cs`, rule(n));
    r.commit("feat: a");
    const plan = buildSpecPlan(r.ctx());
    const code = plan.specs.filter((s) => s.kind === "regra");
    expect(code.length).toBeGreaterThanOrEqual(2);
    for (const s of plan.specs) {
      expect(s.file).toMatch(new RegExp(`^[\\d.]+-${s.audience}-`));
      expect(audienceFromName(s.file)).toBe(s.audience);
    }
    for (const s of code) expect(new Set(s.pointers.map(audienceOfFile)).size).toBe(1);
    expect(code.some((s) => s.audience === "BUS")).toBe(true);
    expect(code.some((s) => s.audience === "ENG")).toBe(true);
    const bus = code.find((s) => s.audience === "BUS")!;
    const sk = renderSpecSkeleton({ id: bus.id, title: bus.title, files: bus.pointers, audience: bus.audience });
    expect(sk.split("\n")[0]).toContain("[BUS]");
    expect(sk).toContain("linguagem de produto");
    expect(renderSpecSkeleton({ id: "1", title: "x", files: [], audience: "ENG" }).split("\n")[0]).toContain("[ENG]");
  });

  it("o briefing das tarefas manda escrever [BUS] em linguagem de produto, sem nomes de código", () => {
    const r = makeRepo();
    r.write("apps.yml", "apps:\n  - dir: pay\n");
    r.write("README.md", "# M\nVisão.");
    r.write("apps/pay/Dockerfile", "FROM scratch");
    r.write("apps/pay/Pay.Domain/Rules/LossRule.cs", rule("LossRule"));
    r.commit("feat: a");
    const g = planSdd(r.ctx(), {})!.guided.find((x) => x.id === "sdd-specs:1")!;
    expect(g.instructions).toContain("[BUS] regra de negócio");
    expect(g.instructions).toContain("linguagem de produto");
    expect(STANDARD_BRIEF).toContain("NÃO cite nomes de classes, métodos, variáveis, campos, interfaces");
    expect(STANDARD_BRIEF).toContain("`[ENG]`");
  });
});

describe("linguagem de produto em 'O que a regra faz' (BUS)", () => {
  it("acusa classe, interface, campo e código entre crases (o caso do Loss Cure Rule)", () => {
    const ruim = spec("`LossCureRule` (`ICureRule`) impede a cura de AP enquanto houver prejuízo (`LossSt`). `IsClientCured` devolve `false` se algum contrato tem `LossSt = true`; a classe é síncrona.");
    const issue = lintSpec(ruim, undefined, { audience: "BUS" }).find((i) => i.rule === "linguagem")!;
    expect(issue.level).toBe("warn");
    for (const t of ["LossCureRule", "ICureRule", "LossSt", "IsClientCured"]) expect(issue.message).toContain(t);
    expect(technicalTerms("O método devolve nulo e usa um enum")).toEqual(expect.arrayContaining(["método", "nulo", "enum"]));
  });

  it("texto de negócio passa; ENG e specs sem marcação não são cobradas; marcas e siglas de negócio não contam", () => {
    const bom = spec("Enquanto o cliente tiver algum contrato em prejuízo, ele não sai da carteira de ativos problemáticos. A cura só é liberada quando nenhum contrato, atual ou do histórico, está em prejuízo. O resultado só informa a decisão; nada muda nos contratos.");
    expect(lintSpec(bom, undefined, { audience: "BUS" }).filter((i) => i.rule === "linguagem")).toEqual([]);
    const tecnico = spec("`BucketReader` lê o bucket e devolve um stream.", "ENG");
    expect(lintSpec(tecnico, undefined, { audience: "ENG" }).filter((i) => i.rule === "linguagem")).toEqual([]);
    expect(lintSpec(tecnico).filter((i) => i.rule === "linguagem")).toEqual([]);
    expect(technicalTerms("As mensagens passam pelo RabbitMQ e pelo PostgreSQL, conforme a política CADOC 3040 e o AP.")).toEqual([]);
  });

  it("lintSpecs só cobra a linguagem das BUS e avisa quando o nome não traz a marcação", () => {
    const r = makeRepo();
    r.write("src/Rules/A.cs", "class A {}");
    r.write("docs/specs/README.md", "# Índice");
    r.write("docs/specs/03.1-BUS-a.md", spec("`LossCureRule` impede a cura."));
    r.write("docs/specs/03.2-ENG-b.md", spec("`BucketReader` lê o bucket.", "ENG"));
    r.write("docs/specs/03.3-sem-marca.md", spec("Descreve a regra em linguagem de negócio."));
    const res = Object.fromEntries(lintSpecs(r.ctx()).map((x) => [path.basename(x.path), x.issues.map((i) => i.rule)]));
    expect(res["03.1-BUS-a.md"]).toContain("linguagem");
    expect(res["03.2-ENG-b.md"]).toEqual([]);
    expect(res["03.3-sem-marca.md"]).toEqual(["marcacao"]);
  });

  it("a migração das specs legadas manda renomear com a marcação e reescrever o bloco em linguagem de produto", () => {
    const r = makeRepo();
    r.write(".sdd/manifest.json", JSON.stringify({ version: 1, projectName: "p", specsDir: "docs/specs", skillSlug: "sdd-p", skillPath: ".claude/skills/sdd-p/SKILL.md", ruleCodeGlobs: ["src/Rules/*"] }));
    r.write(".claude/skills/sdd-p/SKILL.md", "---\nname: sdd-p\n---\nSkill.\n");
    r.write("src/Rules/A.cs", rule("A"));
    r.write("README.md", "# P\nTexto suficiente do README do projeto.");
    r.write("docs/specs/README.md", "# Specs");
    r.write("docs/specs/01-legada.md", spec("`LossCureRule` impede a cura."));
    r.commit("feat: specs");
    const t = planSdd(r.ctx(), {})!.guided.find((g) => g.id === "sdd-migrate:1")!;
    expect(t.instructions).toContain("git mv");
    expect(t.instructions).toContain("-BUS-");
    expect(t.instructions).toContain("sem nomes de classes");
    expect(t.instructions).toContain("marcação BUS");
  });
});

describe("a ação some quando não há o que subir e a sessão avisa quando ainda há ganho", () => {
  function repo() {
    const r = makeRepo();
    r.write("apps.yml", "apps:\n  - dir: pay\n");
    r.write("README.md", "# M\nVisão do produto.");
    r.write("apps/pay/Dockerfile", "FROM scratch");
    for (const n of ["LossRule", "ArrearRule", "DiscountRule"]) r.write(`apps/pay/Pay.Domain/Rules/${n}.cs`, rule(n));
    r.commit("feat: a");
    return r;
  }

  it("com D4 a D8 no máximo, sdd-adopt não aparece em 'Como subir a nota'; antes, aparece", async () => {
    const r = repo();
    const before = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: path.join(home, "a"), groups: ["documentation"] });
    expect(before.data.fixes.map((f) => f.id)).toContain("sdd-adopt");

    const state = await startFix({ root: r.root, rubricPath: RUBRIC_PATH, actionIds: ["sdd-adopt"], params: {}, groups: ["documentation"] });
    const plan = buildSpecPlan(r.ctx());
    // escreve só metade das specs de regra: ainda há ganho
    const rules = plan.specs.filter((s) => s.kind === "regra");
    const std = (s: (typeof plan.specs)[number]) => `# ${s.id} — [${s.audience}] ${s.title}\n\n## O que a regra faz\n\nDescreve a regra em linguagem de negócio.\n\n## Parâmetros\n\nSem parâmetros: nada configurável.\n\n## Contexto\n\nPolítica interna.\n\n---\n\n## Referências técnicas\n\n${s.pointers.map((p) => `Arquivo: ${p}`).join("\n")}\n`;
    const write = (list: typeof plan.specs) => list.forEach((s) => writeFileSync(path.join(r.root, "docs/specs", s.file), std(s)));
    expect(state.session!.reused).toBe(false);
    write(plan.specs.filter((s) => !rules.slice(1).includes(s)));
    writeFileSync(path.join(r.root, "docs/specs/README.md"), `# Specs\n\n${plan.specs.map((s) => `- [${s.title}](./${s.file})`).join("\n")}\n`);
    const partial = await sealFix({ root: r.root, rubricPath: RUBRIC_PATH, skipHooks: true });
    if (rules.length > 1) {
      expect(partial.state.pending?.map((p) => p.id)).toContain("sdd-adopt");
      expect(partial.data.fixes.map((f) => f.id)).toContain("sdd-adopt");
    }

    write(rules.slice(1));
    const manifest = JSON.parse(readFileSync(path.join(r.root, ".sdd/manifest.json"), "utf8")) as { skillPath: string };
    writeFileSync(path.join(r.root, manifest.skillPath), "---\nname: sdd-pay\ndescription: Regras de pagamento\n---\nSkill preenchida pelo time com o mapa das specs.\n");
    const full = await sealFix({ root: r.root, rubricPath: RUBRIC_PATH, skipHooks: true });
    expect(full.state.after!.criteria["D7"]).toBe(2);
    expect(full.data.fixes.map((f) => f.id)).not.toContain("sdd-adopt");
    expect(full.state.pending ?? []).toEqual([]);
  });
});
