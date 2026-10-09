import { afterAll, describe, expect, it } from "vitest";
import { d1Readme } from "../../src/groups/documentation/collectors/d1-readme.js";
import { d2Owners } from "../../src/groups/documentation/collectors/d2-owners.js";
import { d3Adrs } from "../../src/groups/documentation/collectors/d3-adrs.js";
import { d4PathRefs } from "../../src/groups/documentation/collectors/d4-path-refs.js";
import { d5Index, d6Orphans } from "../../src/groups/documentation/collectors/d5-d6-index.js";
import { d7SpecsRules } from "../../src/groups/documentation/collectors/d7-specs-rules.js";
import { d8Hygiene } from "../../src/groups/documentation/collectors/d8-hygiene.js";
import { sddHealth } from "../../src/groups/documentation/panels.js";
import { cleanupFixtures, evidenceOf, makeRepo, run1, valueOf } from "../fixture-repo.js";

afterAll(cleanupFixtures);

const FULL_README = ["# App", "## Description", "x", "## Running the app", "x", "## Configuração", "x", "## Test", "x", "## Deploy", "x", "## Responsáveis", "x"].join("\n");

describe("D1 · README por app com seções obrigatórias", () => {
  it("apps vêm do apps.yml; app fora da lista não entra; % de apps conformes", async () => {
    const r = makeRepo();
    r.write("apps.yml", "apps:\n  - dir: app-a\n  - dir: app-b\n");
    r.write("apps/app-a/README.md", FULL_README);
    r.write("apps/app-b/README.md", "# B\n## Description\nx\n## Running\nx\n");
    r.write("apps/app-c/README.md", "# C");
    const res = await run1(d1Readme, r.ctx());
    expect(valueOf(res)).toBe(50);
    expect(evidenceOf(res)).toHaveLength(1);
    expect(evidenceOf(res)[0]).toMatchObject({ path: "apps/app-b/README.md", note: expect.stringContaining("Configuração, Testes, Deploy, Responsáveis") });
  });

  it("app sem README é evidência de job; repo sem apps/ conta como um app só (a raiz)", async () => {
    const r = makeRepo();
    r.write("src/x.cs", "class X {}");
    const res = await run1(d1Readme, r.ctx());
    expect(valueOf(res)).toBe(0);
    expect(evidenceOf(res)[0]).toMatchObject({ kind: "job" });
    r.write("README.md", FULL_README);
    expect(valueOf(await run1(d1Readme, r.ctx()))).toBe(100);
  });

  it("a lista de seções obrigatórias é parametrizável na política", async () => {
    const r = makeRepo();
    r.write("README.md", FULL_README);
    const custom = r.ctx({ docs: { readme_required_sections: [{ id: "lic", label: "Licença", match: ["licen[cç]a"] }] } as never });
    expect(valueOf(await run1(d1Readme, custom))).toBe(0);
    const none = r.ctx({ docs: { readme_required_sections: [] } as never });
    expect(valueOf(await run1(d1Readme, none))).toBe(100);
  });
});

describe("D2 · OWNERS preenchido e consistente com o CODEOWNERS", () => {
  it("separa app ok, texto-modelo, sem arquivo e dono fora do CODEOWNERS", async () => {
    const r = makeRepo();
    r.write(".github/CODEOWNERS", "* @org/team\n");
    for (const a of ["a", "b", "c", "d"]) r.write(`apps/${a}/Dockerfile`, "FROM scratch");
    r.write("apps/a/OWNERS.md", "# Mantenedores\n\n- @org/team\n");
    r.write("apps/b/OWNERS.md", "Mantenedores\nColoque aqui o nome do mantenedor 1\nColoque aqui o nome do mantenedor 2");
    r.write("apps/d/OWNERS.md", "# Mantenedores\n- @outra/equipe\n");
    const res = await run1(d2Owners, r.ctx());
    expect(valueOf(res)).toBe(25);
    const notes = evidenceOf(res).map((e) => (e.kind === "file" || e.kind === "job" ? e.note : ""));
    expect(notes.join("|")).toContain("texto-modelo");
    expect(notes.join("|")).toContain("sem OWNERS.md");
    expect(notes.join("|")).toContain("fora do CODEOWNERS");
  });

  it("sem CODEOWNERS nenhum app é consistente", async () => {
    const r = makeRepo();
    r.write("OWNERS.md", "- Maria Silva\n- @org/team\n");
    const res = await run1(d2Owners, r.ctx());
    expect(valueOf(res)).toBe(0);
    expect(JSON.stringify(res)).toContain("não tem CODEOWNERS");
  });
});

describe("D3 · ADRs", () => {
  const now = new Date("2026-10-08T12:00:00Z");

  it("recent se algum ADR mudou nos últimos 12 meses; present se mais antigo; absent sem ADR", async () => {
    const recent = makeRepo();
    recent.write("docs/adr/0001-x.md", "# x");
    recent.commit("feat: adr", "2026-06-01T10:00:00Z");
    expect(valueOf(await run1(d3Adrs, recent.ctx({}, now)))).toBe("recent");

    const old = makeRepo();
    old.write("docs/adr/0001-x.md", "# x");
    old.commit("feat: adr", "2024-01-01T10:00:00Z");
    expect(valueOf(await run1(d3Adrs, old.ctx({}, now)))).toBe("present");

    const none = makeRepo();
    none.write("README.md", "x");
    expect(valueOf(await run1(d3Adrs, none.ctx({}, now)))).toBe("absent");
  });

  it("ADR criado ou alterado e ainda sem commit conta como recente (o commit é do usuário)", async () => {
    const stale = makeRepo();
    stale.write("docs/adr/0001-x.md", "# x");
    stale.commit("feat: adr", "2024-01-01T10:00:00Z");
    expect(valueOf(await run1(d3Adrs, stale.ctx({}, now)))).toBe("present");
    stale.write("docs/adr/0002-novo.md", "# novo, sem commit"); // criado pela skill, ainda não commitado
    expect(valueOf(await run1(d3Adrs, stale.ctx({}, now)))).toBe("recent");

    const edited = makeRepo();
    edited.write("docs/adr/0001-x.md", "# x");
    edited.commit("feat: adr", "2024-01-01T10:00:00Z");
    edited.write("docs/adr/0001-x.md", "# x editado, sem commit");
    expect(valueOf(await run1(d3Adrs, edited.ctx({}, now)))).toBe("recent");
  });

  it("README e template dentro da pasta de ADR não contam como ADR", async () => {
    const r = makeRepo();
    r.write("docs/adr/README.md", "# índice");
    r.write("docs/adr/template.md", "# t");
    expect(valueOf(await run1(d3Adrs, r.ctx()))).toBe("absent");
  });
});


describe("D4 · referências de caminho válidas", () => {
  it("links, Arquivo: e caminhos entre crases; ignora URLs, âncoras e blocos de código", async () => {
    const r = makeRepo();
    r.write("src/Foo.cs", "class Foo {}");
    r.write("docs/a.md", "# A");
    r.write(
      "README.md",
      [
        "# R",
        "[ok](docs/a.md) [quebrado](docs/missing.md) [site](https://example.com/x.md) [âncora](#topo) [com âncora](docs/a.md#secao)",
        "Arquivo: src/Foo.cs",
        "Arquivo: src/Gone.cs",
        "Veja `src/Foo.cs` e `Microsoft.AspNetCore/Foo.Bar` e `src/*.cs`.",
        "```",
        "[ignorado](nao/existe.md)",
        "```",
      ].join("\n"),
    );
    const res = await run1(d4PathRefs, r.ctx());
    // válidas: docs/a.md (citado duas vezes na linha, conta uma), Arquivo Foo, `src/Foo.cs`; quebradas: docs/missing.md, Arquivo Gone
    expect(valueOf(res)).toBeCloseTo((3 / 5) * 100, 1);
    expect(evidenceOf(res).map((e) => (e.kind === "file" ? e.snippet : ""))).toEqual(["docs/missing.md", "src/Gone.cs"]);
  });

  it("sem nenhuma referência é N/A", async () => {
    const r = makeRepo();
    r.write("README.md", "# só texto");
    expect((await run1(d4PathRefs, r.ctx())).status).toBe("not_applicable");
  });

  it("links relativos resolvem a partir da pasta do documento", async () => {
    const r = makeRepo();
    r.write("docs/specs/01.md", "# 1\n[vizinho](02.md) [pai](../README.md)");
    r.write("docs/specs/02.md", "# 2");
    r.write("docs/README.md", "# D");
    expect(valueOf(await run1(d4PathRefs, r.ctx()))).toBe(100);
  });
});

describe("D5 · índice da raiz completo", () => {
  it("% dos docs de primeiro nível listados no índice", async () => {
    const r = makeRepo();
    r.write("README.md", "# R\n[a](docs/a.md)");
    r.write("docs/a.md", "# A");
    r.write("docs/b.md", "# B");
    const res = await run1(d5Index, r.ctx());
    expect(valueOf(res)).toBe(50);
    expect(evidenceOf(res)[0]).toMatchObject({ path: "docs/b.md" });
    r.write("docs/README.md", "# Docs\n[b](b.md)");
    expect(valueOf(await run1(d5Index, r.ctx()))).toBe(100);
  });

  it("subpasta com README conta pelo README; sem índice mede 0; só README é N/A", async () => {
    const r = makeRepo();
    r.write("docs/specs/README.md", "# Specs");
    r.write("docs/specs/01.md", "# 1");
    r.write("docs/playbooks/p.md", "# P");
    expect(valueOf(await run1(d5Index, r.ctx()))).toBe(0);
    r.write("README.md", "# R\n[specs](docs/specs/) [p](docs/playbooks/p.md)");
    expect(valueOf(await run1(d5Index, r.ctx()))).toBe(100);
    const only = makeRepo();
    only.write("README.md", "# R");
    expect((await run1(d5Index, only.ctx())).status).toBe("not_applicable");
  });
});

describe("D6 · documentação sem órfãos", () => {
  it("doc sem link de entrada é órfão; README, OWNERS e SKILL são exceção por convenção", async () => {
    const r = makeRepo();
    r.write("README.md", "# R\n[x](docs/x.md)");
    r.write("docs/x.md", "# X");
    r.write("docs/y.md", "# Y");
    r.write("OWNERS.md", "- @a/b");
    r.write(".claude/skills/s/SKILL.md", "---\nname: s\n---\n");
    const res = await run1(d6Orphans, r.ctx());
    expect(valueOf(res)).toBe(50);
    expect(evidenceOf(res)[0]).toMatchObject({ path: "docs/y.md" });
  });

  it("link para uma pasta conta para o README dela", async () => {
    const r = makeRepo();
    r.write("README.md", "# R\n[specs](docs/specs/)");
    r.write("docs/specs/README.md", "# S\n[1](01.md)");
    r.write("docs/specs/01.md", "# 1");
    expect(valueOf(await run1(d6Orphans, r.ctx()))).toBe(100);
  });
});

describe("D7 · specs ligadas às regras", () => {
  const manifest = (globs: string[]) => JSON.stringify({ version: 1, projectName: "p", specsDir: "docs/specs", skillSlug: "sdd-p", skillPath: ".claude/skills/sdd-p/SKILL.md", ruleCodeGlobs: globs });

  it("% dos arquivos de regra citados por specs (testes não contam)", async () => {
    const r = makeRepo();
    r.write(".sdd/manifest.json", manifest(["*/Rules/*"]));
    r.write("src/Rules/A.cs", "class A {}");
    r.write("src/Rules/B.cs", "class B {}");
    r.write("tests/Rules/BTests.cs", "class BTests {}");
    r.write("docs/specs/README.md", "# S");
    r.write("docs/specs/01.md", "# 1\nArquivo: src/Rules/A.cs\n");
    const res = await run1(d7SpecsRules, r.ctx());
    expect(valueOf(res)).toBe(50);
    expect(evidenceOf(res).find((e) => e.kind === "file")).toMatchObject({ path: "src/Rules/B.cs", note: "no perímetro, mas nenhuma spec a cita" });
    r.write("docs/specs/02.md", "# 2\nArquivo: src/Rules/B.cs\n");
    expect(valueOf(await run1(d7SpecsRules, r.ctx()))).toBe(100);
  });

  it("citação de pasta cobre os arquivos dentro dela; globs vêm também da política", async () => {
    const r = makeRepo();
    r.write("src/Rules/A.cs", "class A {}");
    r.write("docs/regras.md", "# R\nArquivo: src/Rules/\n");
    expect(valueOf(await run1(d7SpecsRules, r.ctx({ docs: { rule_globs: ["src/Rules/*"] } as never })))).toBe(100);
  });

  it("sem SDD e com regra de negócio no repo, a ausência de spec é a medição: 0%, não 'não medido'", async () => {
    const rule = (n: string) => `public class ${n}\n{\n${Array.from({ length: 30 }, (_, i) => `    public int M${n}${i}(int v) { if (v > ${i + 3}) { return v * ${i + 5}; } else if (v < ${i + 2}) { return ${i + 7}; } return v; }`).join("\n")}\n}\n`;
    const r = makeRepo();
    r.write("README.md", "# Projeto\nDescrição suficiente para não ser um documento vazio.");
    for (const n of ["LossRule", "ArrearRule", "DiscountRule"]) r.write(`src/Domain/Rules/${n}.cs`, rule(n));
    const res = await run1(d7SpecsRules, r.ctx());
    expect(res.status).toBe("measured");
    expect(valueOf(res)).toBe(0);
    expect(JSON.stringify(res)).toContain("SDD ausente");
    // com menos de 3 regras o critério não se aplica de fato
    const poucas = makeRepo();
    poucas.write("src/Domain/Rules/LossRule.cs", rule("LossRule"));
    expect((await run1(d7SpecsRules, poucas.ctx())).status).toBe("unmeasured");
  });

  it("sem regra de negócio no repo, ou com globs que não casam nada, não mede (não é N/A silencioso)", async () => {
    const r = makeRepo();
    r.write("docs/a.md", "# a");
    expect((await run1(d7SpecsRules, r.ctx())).status).toBe("unmeasured");
    expect((await run1(d7SpecsRules, r.ctx({ docs: { rule_globs: ["nada/*"] } as never }))).status).toBe("unmeasured");
  });
});

describe("D8 · higiene de docs", () => {
  it("conta arquivos residuais, relatórios efêmeros, docs vazios, pendências e docs soltos", async () => {
    const r = makeRepo();
    r.write("README.md", "# Projeto\nDescrição suficiente para não ser um documento vazio.");
    r.write("docs/.DS_Store", "x");
    r.write("src/Old.cs.bak", "x");
    r.write("docs/specs/.impact-reports/commit-1.md", "# relatório de impacto gerado automaticamente");
    r.write("docs/vazio.md", "#");
    r.write("docs/pendente.md", "# Pendente\nCOLOQUE AQUI o conteúdo real do documento, ainda não escrito.");
    r.write("PROMPT_PROXIMOS_PASSOS.md", "# Próximos passos\nTexto longo o bastante para não ser considerado vazio pelo coletor.");
    const res = await run1(d8Hygiene, r.ctx());
    expect(valueOf(res)).toBe(6);
    const kinds = evidenceOf(res).map((e) => (e.kind === "file" ? e.note : ""));
    expect(kinds).toEqual(expect.arrayContaining(["arquivo residual", "relatório efêmero versionado", "documento vazio", "marcador de pendência", "documento solto"]));
  });

  it("palavra comum que contém 'a preencher' dentro de outra não conta; repo limpo mede 0", async () => {
    const r = makeRepo();
    r.write("README.md", "# P\nO default seguro depende de os publishers nunca preencherem o campo, e isso é aceito.");
    const res = await run1(d8Hygiene, r.ctx());
    expect(valueOf(res)).toBe(0);
    expect(evidenceOf(res)[0]).toMatchObject({ kind: "job" });
  });

  it("residual_patterns da política entram na contagem", async () => {
    const r = makeRepo();
    r.write("README.md", "# P\nDescrição suficiente para não ser vazio, de verdade.");
    r.write("scratch/notas.txt", "x");
    expect(valueOf(await run1(d8Hygiene, r.ctx({ docs: { residual_patterns: ["^scratch/"] } as never })))).toBe(1);
  });
});

describe("painel SDD: saúde", () => {
  it("repo sem SDD aparece como não adotado; com manifest e hooks mostra cada peça", () => {
    const none = makeRepo();
    none.write("README.md", "# x");
    expect(sddHealth(none.ctx()).adopted).toBe(false);

    const r = makeRepo();
    r.write(".sdd/manifest.json", JSON.stringify({ version: 1, projectName: "p", specsDir: "docs/specs", skillSlug: "sdd-p", skillPath: ".claude/skills/sdd-p/SKILL.md", ruleCodeGlobs: ["src/Rules/*"] }));
    r.write("docs/specs/README.md", "# S\n[1](01.md)");
    r.write("docs/specs/01.md", "# 1\nArquivo: src/Rules/A.cs\nArquivo: src/Rules/Gone.cs\n");
    r.write("src/Rules/A.cs", "class A {}");
    r.write(".claude/skills/sdd-p/SKILL.md", "---\nname: sdd-p\n---\nTODO");
    const h = sddHealth(r.ctx());
    expect(h.adopted).toBe(true);
    const by = Object.fromEntries(h.items.map((i) => [i.label, i]));
    expect(by["Manifest"]!.status).toBe("ok");
    expect(by["Specs"]!.status).toBe("ok");
    expect(by["Citações"]).toMatchObject({ status: "warn", detail: "2 de 3 referências válidas" });
    expect(by["Regras ligadas a specs"]).toMatchObject({ status: "ok" });
    expect(by["Perímetro do manifest"]).toMatchObject({ status: "ok" });
    expect(by["Skill do domínio"]!.status).toBe("warn");
    expect(by["Hooks versionados"]!.status).toBe("fail");
    expect(by["Hooks ativos neste clone"]!.status).toBe("fail");
  });
});

describe("calibração contra repos reais", () => {
  it("D4: 'Arquivo: caminho' (exemplo), caminho/do/arquivo.ext e link com crases não contam como quebrados nem em dobro", async () => {
    const r = makeRepo();
    r.write("src/A.cs", "class A {}");
    r.write("README.md", "# R\nUse `Arquivo: caminho` assim.\nArquivo: caminho/do/arquivo.ext\n[`src/A.cs`](src/A.cs)\n");
    const res = await run1(d4PathRefs, r.ctx());
    expect(valueOf(res)).toBe(100);
    expect(JSON.stringify(res)).toContain("1 referências"); // o link e o código no mesmo alvo contam uma vez
  });

  it("D4: citação relativa à raiz do app (doc dentro de apps/<app>/) resolve", async () => {
    const r = makeRepo();
    r.write("apps/x/Domain/Rule.cs", "class R {}");
    r.write("apps/x/.github/skills/s/SKILL.md", "# s\nArquivo: Domain/Rule.cs\n");
    expect(valueOf(await run1(d4PathRefs, r.ctx()))).toBe(100);
  });

  it("D4: link Markdown continua estrito (só relativo ao próprio doc)", async () => {
    const r = makeRepo();
    r.write("apps/x/Domain/Rule.cs", "class R {}");
    r.write("apps/x/docs/a.md", "# a\n[regra](Domain/Rule.cs)\n");
    expect(valueOf(await run1(d4PathRefs, r.ctx()))).toBe(0);
  });

  it("D8: a palavra portuguesa 'todo' não é marcador; TODO em caixa-alta é", async () => {
    const r = makeRepo();
    r.write("README.md", "# P\nTodo o fluxo passa por aqui, e todo cuidado é pouco neste processo inteiro.");
    expect(valueOf(await run1(d8Hygiene, r.ctx()))).toBe(0);
    r.write("docs/n.md", "# N\nTODO: escrever esta parte do documento com calma e detalhe.");
    expect(valueOf(await run1(d8Hygiene, r.ctx()))).toBe(1);
  });

  it("D2: 'todo' em português não é placeholder", async () => {
    const r = makeRepo();
    r.write(".github/CODEOWNERS", "* @org/team\n");
    r.write("OWNERS.md", "# Mantenedores\n- @org/team (responsável por todo o serviço)\n");
    expect(valueOf(await run1(d2Owners, r.ctx()))).toBe(100);
  });
});


describe("D7 · universo de regras (perímetro do manifest × specs × irmãos)", () => {
  const bigRule = (name: string) =>
    `class ${name} {\n${Array.from({ length: 30 }, (_, i) => `  int M${i}(int v) { if (v > ${i + 3}) { return v * ${i + 5}; } else if (v < ${i + 2}) { return ${i + 7}; } return v; }`).join("\n")}\n}\n`;

  const manifest = (globs: string[]) => JSON.stringify({ version: 1, projectName: "p", specsDir: "docs/specs", skillSlug: "sdd-p", skillPath: ".claude/skills/sdd-p/SKILL.md", ruleCodeGlobs: globs });
  function repoWithGap() {
    const r = makeRepo();
    r.write(".sdd/manifest.json", manifest(["src/Rules/*"]));
    for (const f of ["src/Rules/A.cs", "src/Rules/B.cs", "src/Handlers/H1.cs", "src/Handlers/H2.cs"]) r.write(f, "class X { }");
    r.write("src/Handlers/H3.cs", bigRule("H3")); // irmã com lógica de negócio de verdade
    r.write("src/Handlers/Trivial.cs", "class Trivial { }"); // irmã trivial: não é regra
    r.write("src/Handlers/IHandler.cs", "interface IHandler { }"); // interface: não é regra
    r.write("src/Dtos/Dto.cs", "class Dto { }"); // dados: não é regra
    r.write("docs/specs/README.md", "# S\n[1](01.md)");
    r.write("docs/specs/01.md", "# 1\nArquivo: src/Rules/A.cs\nArquivo: src/Handlers/H1.cs\nArquivo: src/Handlers/H2.cs\nArquivo: src/Dtos/Dto.cs\n");
    return r;
  }

  it("o manifest estreito é a lacuna: regra citada fora do perímetro e irmã sem spec contam contra o D7", async () => {
    const r = repoWithGap();
    const res = await run1(d7SpecsRules, r.ctx());
    // universo: A, B (perímetro) + H1, H2 (citados) + H3 (irmão); interface e DTO ficam de fora
    expect(valueOf(res)).toBe(20); // só A está no perímetro E citada
    const notes = evidenceOf(res).map((e) => (e.kind === "file" ? `${e.path}: ${e.note}` : e.note ?? ""));
    expect(notes.join("\n")).toContain("src/Handlers/H1.cs: citada por docs/specs/01.md, fora do perímetro");
    expect(notes.join("\n")).toContain("src/Rules/B.cs: no perímetro, mas nenhuma spec a cita");
    expect(notes.join("\n")).toContain("src/Handlers/H3.cs: irmã das regras conhecidas");
    expect(notes.join("\n")).not.toContain("IHandler");
    expect(notes.join("\n")).not.toContain("Trivial");
    expect(notes.join("\n")).not.toContain("Dto.cs");
    expect(notes[0]).toContain("universo de 5 arquivos");
  });

  it("a exclusão revisada (rule_exclude_globs) tira o arquivo do universo", async () => {
    const r = repoWithGap();
    const res = await run1(d7SpecsRules, r.ctx({ docs: { rule_exclude_globs: ["src/Handlers/H3.cs"] } as never }));
    expect(valueOf(res)).toBe(25); // A ligada de 4
    expect(JSON.stringify(res)).not.toContain("H3.cs");
  });

  it("manifest com perímetro vazio mas specs que citam código: mede 0 (não 'não medido')", async () => {
    const r = repoWithGap();
    r.write(".sdd/manifest.json", manifest([]));
    expect(valueOf(await run1(d7SpecsRules, r.ctx()))).toBe(0);
  });
});
