import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkRefs, formatRefCheck } from "../../src/groups/documentation/checks.js";
import { planReadme } from "../../src/groups/documentation/remediation/readme.js";
import { PATH_RULES_TITLE } from "../../src/groups/documentation/shared/path-rules.js";
import { planSdd } from "../../src/groups/documentation/sdd/scaffold.js";
import { findRegressions, sealFix, startFix } from "../../src/remediation/engine.js";
import { formatSeal } from "../../src/remediation/format.js";
import { cleanupFixtures, makeRepo } from "../fixture-repo.js";
import { RUBRIC_PATH } from "../helpers.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "rs-paths-"));
  process.env["REPO_SCORE_HOME"] = home;
});
afterAll(() => {
  cleanupFixtures();
  rmSync(home, { recursive: true, force: true });
});

const rule = (n: string) => `public class ${n}\n{\n${Array.from({ length: 30 }, (_, i) => `    public int M${n}${i}(int v) { if (v > ${i + 3}) { return v * ${i + 5}; } else if (v < ${i + 2}) { return ${i + 7}; } return v; }`).join("\n")}\n}\n`;

describe("regra de caminhos em todo briefing guiado", () => {
  it("README, skill do SDD, lotes de specs, visão geral e lacunas carregam a regra", () => {
    const zero = makeRepo();
    zero.write("apps.yml", "apps:\n  - dir: pay\n");
    zero.write("README.md", "# M\nVisão do produto.");
    zero.write("apps/pay/Dockerfile", "FROM scratch");
    for (const n of ["LossRule", "ArrearRule", "DiscountRule"]) zero.write(`apps/pay/Pay.Domain/Rules/${n}.cs`, rule(n));
    zero.commit("feat: a");
    const adopt = planSdd(zero.ctx(), {})!.guided;
    expect(adopt.map((g) => g.id)).toEqual(expect.arrayContaining(["sdd-specs:1", "sdd-overview", "sdd-skill"]));

    const readme = planReadme(zero.ctx())!.guided;
    expect(readme.length).toBeGreaterThan(0);

    const migrate = makeRepo();
    migrate.write(".sdd/manifest.json", JSON.stringify({ version: 1, projectName: "p", specsDir: "docs/specs", skillSlug: "sdd-p", skillPath: ".claude/skills/sdd-p/SKILL.md", ruleCodeGlobs: ["src/Rules/*"] }));
    migrate.write(".claude/skills/sdd-p/SKILL.md", "---\nname: sdd-p\n---\nSkill.\n");
    for (const n of ["A", "B", "C"]) migrate.write(`src/Rules/${n}.cs`, rule(n));
    migrate.write("README.md", "# P\nTexto suficiente do README do projeto.");
    migrate.write("docs/specs/README.md", "# Specs");
    migrate.write("docs/specs/01-legada.md", "# 01\n\nTexto solto.\n\nArquivo: src/Rules/A.cs\n");
    migrate.commit("feat: specs");
    const gapAndMigrate = planSdd(migrate.ctx(), {})!.guided;
    expect(gapAndMigrate.map((g) => g.id)).toEqual(expect.arrayContaining(["sdd-gap-specs", "sdd-migrate:1"]));

    for (const task of [...adopt, ...readme, ...gapAndMigrate]) {
      expect(task.instructions, task.id).toContain(PATH_RULES_TITLE);
      expect(task.instructions, task.id).toContain("completo, relativo à raiz do repo");
      expect(task.instructions, task.id).toContain("texto simples");
    }
  });
});

describe("check refs", () => {
  it("aponta caminho abreviado ou inexistente com arquivo:linha e sugere o caminho completo quando é único", () => {
    const r = makeRepo();
    r.write("apps/pay/Worker/Receivers/MessageHandler.cs", "class X {}");
    r.write("README.md", "# Projeto\n\nVeja `apps/pay/Worker/Receivers/MessageHandler.cs` e [guia](docs/guia.md).\n");
    r.write("docs/guia.md", "# Guia\n\nConteúdo suficiente do guia.\n");
    r.commit("feat: a");
    // o último `Arquivo:` resolve: o D4 aceita caminho relativo à pasta do app (ancestral)
    r.write("apps/pay/README.md", "# Pay\n\nSeção sobre `Receivers/MessageHandler.cs`, o [guia](guia.md) e `apps/pay/Migrations/001.sql`.\n\nArquivo: Worker/Receivers/MessageHandler.cs\n");
    const res = checkRefs(r.ctx(), { files: ["apps/pay/README.md"] });
    const byRaw = Object.fromEntries(res.broken.map((b) => [b.raw, b]));
    expect(Object.keys(byRaw).sort()).toEqual(["Receivers/MessageHandler.cs", "guia.md", "apps/pay/Migrations/001.sql"].sort());
    expect(byRaw["Receivers/MessageHandler.cs"]!.suggestion).toBe("apps/pay/Worker/Receivers/MessageHandler.cs");
    expect(byRaw["guia.md"]!.suggestion).toBe("../../docs/guia.md");
    expect(byRaw["apps/pay/Migrations/001.sql"]!.suggestion).toBeNull();
    expect(res.broken.every((b) => b.doc === "apps/pay/README.md" && b.line > 0)).toBe(true);
    const text = formatRefCheck(res);
    expect(text).toContain("apps/pay/README.md:");
    expect(text).toContain("use apps/pay/Worker/Receivers/MessageHandler.cs");
    expect(text).toContain("texto simples");
  });

  it("escopo 'alterados' ignora documentos intactos e passa limpo quando tudo resolve", () => {
    const r = makeRepo();
    r.write("src/A.cs", "class A {}");
    r.write("docs/velho.md", "# Velho\n\nAponta para `src/Antigo.cs`, que não existe mais.\n");
    r.commit("feat: a");
    r.write("docs/novo.md", "# Novo\n\nAponta para `src/A.cs`.\n");
    expect(checkRefs(r.ctx(), { files: ["docs/novo.md"] }).broken).toEqual([]);
    expect(formatRefCheck(checkRefs(r.ctx(), { files: ["docs/novo.md"] }))).toContain("Caminhos OK");
    expect(checkRefs(r.ctx()).broken.map((b) => b.doc)).toEqual(["docs/velho.md"]); // --all pega o legado
  });
});

describe("o seal destaca critério que piorou", () => {
  it("README novo com caminhos abreviados derruba o D4: PIOROU, com a evidência e o caminho para reparar", async () => {
    const r = makeRepo();
    r.write("src/A.cs", "class A {}");
    r.write("README.md", "# Projeto\n\nDescrição suficiente. Veja `src/A.cs` e [o guia](docs/guia.md).\n");
    r.write("docs/guia.md", "# Guia\n\nConteúdo suficiente do guia, que aponta para `src/A.cs`.\n");
    r.write("junk.bak", "x");
    r.commit("feat: a");
    await startFix({ root: r.root, rubricPath: RUBRIC_PATH, actionIds: ["doc-hygiene"], params: {}, groups: ["documentation"] });
    // simula uma tarefa guiada que escreve caminhos abreviados
    writeFileSync(path.join(r.root, "docs/ruim.md"), "# Ruim\n\nVeja `Receivers/X.cs`, `Migrations/001.sql`, `apps/Y/Z.cs` e [aqui](nao-existe.md).\n");
    const sealed = await sealFix({ root: r.root, rubricPath: RUBRIC_PATH });
    expect(sealed.state.regressions!.map((x) => x.id)).toContain("D4");
    const d4 = sealed.state.regressions!.find((x) => x.id === "D4")!;
    expect(d4.from).toBeGreaterThan(d4.to);
    expect(d4.evidence.join(" ")).toContain("docs/ruim.md");
    const text = formatSeal(sealed);
    expect(text).toContain("PIOROU");
    expect(text).toContain("check refs");
    expect(text).toContain("não apresente esta correção como concluída");
  });

  it("sem piora, não aparece; findRegressions só olha critérios medidos nos dois lados", () => {
    const s = (criteria: Record<string, number | null>) => ({ grade: "E" as const, computed_grade: null, total: 0, coverage_weight: 1, dimensions: {}, criteria, blocked_by: [] });
    const data = { result: { dimensions: {} }, fixes: [], criteria: {} } as never;
    expect(findRegressions(s({ D4: 2, D7: null }), s({ D4: 2, D7: 0 }), data)).toEqual([]); // não medido → medido 0 não é piora
    expect(findRegressions(s({ D4: 2 }), s({ D4: 1 }), data).map((x) => x.id)).toEqual(["D4"]);
  });
});
