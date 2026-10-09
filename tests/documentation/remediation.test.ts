import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../../src/analyze.js";
import { ApplyError, applyChanges } from "../../src/remediation/apply.js";
import { finishFix, FixError, previewFixes, resumeFix, sealFix, startFix } from "../../src/remediation/engine.js";
import { HOOK_FILES } from "../../src/groups/documentation/sdd/templates.js";
import { cleanupFixtures, makeRepo, type FixtureRepo } from "../fixture-repo.js";
import { RUBRIC_PATH } from "../helpers.js";

let home: string;
const prevHome = process.env["REPO_SCORE_HOME"];

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "rs-fixhome-"));
  process.env["REPO_SCORE_HOME"] = home;
});
afterAll(() => {
  cleanupFixtures();
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env["REPO_SCORE_HOME"];
  else process.env["REPO_SCORE_HOME"] = prevHome;
});

const start = (r: FixtureRepo, actionIds: string[], extra: Partial<Parameters<typeof startFix>[0]> = {}) =>
  startFix({ root: r.root, rubricPath: RUBRIC_PATH, actionIds, params: {}, groups: ["documentation"], ...extra });
const seal = (r: FixtureRepo, skipHooks = false) => sealFix({ root: r.root, rubricPath: RUBRIC_PATH, skipHooks });
const branchOf = (r: FixtureRepo) => r.git("symbolic-ref", "--short", "HEAD").trim();
const sha = (r: FixtureRepo, ref = "HEAD") => r.git("rev-parse", ref).trim();

/** Repo com 5 resíduos rastreados (D8 = 5 → 0 pontos). */
function dirtyDocsRepo(): FixtureRepo {
  const r = makeRepo();
  r.write("README.md", "# Projeto\nDescrição suficiente para não ser um documento vazio.");
  for (const f of [".DS_Store", "a.bak", "b.bak", "c.orig", "d.swp"]) r.write(f, "x");
  r.commit("feat: inicial");
  return r;
}

describe("branch nova: a origem nunca é alterada", () => {
  it("preview não escreve nada nem cria branch", () => {
    const r = dirtyDocsRepo();
    const items = previewFixes({ root: r.root, actionIds: ["doc-hygiene"], params: {} });
    expect(items[0]!.changes.filter((c) => c.op === "remove" || c.lines === "remoção")).toHaveLength(5);
    expect(existsSync(path.join(r.root, ".DS_Store"))).toBe(true);
    expect(r.git("branch", "--list").trim().split("\n")).toHaveLength(1);
  });

  it("start cria docs/repo-score-*, aplica e commita lá; a branch de origem fica idêntica", async () => {
    const r = dirtyDocsRepo();
    const before = sha(r);
    const state = await start(r, ["doc-hygiene"]);
    expect(state.branch).toMatch(/^docs\/repo-score-\d{8}-\d{4}/);
    expect(state.base_branch).toBe("main");
    expect(branchOf(r)).toBe(state.branch);
    expect(state.commits).toHaveLength(1);
    expect(existsSync(path.join(r.root, ".DS_Store"))).toBe(false);
    expect(readFileSync(path.join(r.root, ".gitignore"), "utf8")).toContain("*.bak");
    // a origem não mudou, nem em commit nem em conteúdo
    expect(sha(r, "main")).toBe(before);
    expect(r.git("show", "main:.DS_Store")).toBe("x");
  });

  it("seal recalcula a nota NA branch nova e mostra antes/depois", async () => {
    const r = dirtyDocsRepo();
    await start(r, ["doc-hygiene"]);
    const res = await seal(r);
    expect(res.state.status).toBe("sealed");
    expect(res.state.baseline.criteria["D8"]).toBe(0);
    expect(res.state.after!.criteria["D8"]).toBe(2);
    expect(res.state.after!.total!).toBeGreaterThan(res.state.baseline.total!);
    expect(res.data.meta.branch).toBe(res.state.branch); // medido na branch da correção
    expect(res.files).toContain(".DS_Store");
  });

  it("finish keep volta à origem e mantém a branch; merge integra sem push; discard exige confirmação", async () => {
    const keep = dirtyDocsRepo();
    const s1 = await start(keep, ["doc-hygiene"]);
    await seal(keep);
    expect(finishFix({ root: keep.root, decision: "keep" }).message).toContain(s1.branch);
    expect(branchOf(keep)).toBe("main");
    expect(keep.git("branch", "--list", s1.branch).trim()).not.toBe("");
    expect(existsSync(path.join(keep.root, ".DS_Store"))).toBe(true);

    const merge = dirtyDocsRepo();
    const s2 = await start(merge, ["doc-hygiene"]);
    await seal(merge);
    const res = finishFix({ root: merge.root, decision: "merge" });
    expect(res.state.status).toBe("merged");
    expect(branchOf(merge)).toBe("main");
    expect(existsSync(path.join(merge.root, ".DS_Store"))).toBe(false);
    expect(merge.git("log", "--merges", "--format=%s", "-1").trim()).toContain(s2.branch);
    expect(merge.git("remote").trim()).toBe(""); // nunca faz push

    const drop = dirtyDocsRepo();
    const s3 = await start(drop, ["doc-hygiene"]);
    await seal(drop);
    expect(() => finishFix({ root: drop.root, decision: "discard" })).toThrow(/--confirm/);
    finishFix({ root: drop.root, decision: "discard", confirm: true });
    expect(branchOf(drop)).toBe("main");
    expect(drop.git("branch", "--list", s3.branch).trim()).toBe("");
  });

  it("recusa árvore suja sem --allow-dirty e recusa uma segunda correção enquanto a primeira não foi concluída", async () => {
    const r = dirtyDocsRepo();
    r.write("novo.txt", "não commitado");
    await expect(start(r, ["doc-hygiene"])).rejects.toThrow(/alterações não commitadas/);
    expect(r.git("branch", "--list").trim().split("\n")).toHaveLength(1);

    const clean = dirtyDocsRepo();
    await start(clean, ["doc-hygiene"]);
    clean.git("switch", "main");
    await expect(start(clean, ["doc-hygiene"])).rejects.toThrow(/em andamento/);
  });

  it("sem trabalho a fazer não deixa branch para trás", async () => {
    const r = makeRepo();
    r.write("README.md", "# Projeto\nDescrição suficiente para não ser um documento vazio.");
    r.commit("feat: inicial");
    const state = await start(r, ["doc-hygiene"]);
    expect(state.status).toBe("nothing_to_do");
    expect(branchOf(r)).toBe("main");
    expect(r.git("branch", "--list").trim().split("\n")).toHaveLength(1);
  });

  it("ação desconhecida e merge antes do seal falham com mensagem clara", async () => {
    const r = dirtyDocsRepo();
    await expect(start(r, ["nao-existe"])).rejects.toThrow(/ação desconhecida/);
    await start(r, ["doc-hygiene"]);
    r.write("pendente.txt", "x");
    expect(() => finishFix({ root: r.root, decision: "merge" })).toThrow(/não commitadas/);
  });

  it("um commit bloqueado por hook não é contornado sozinho; --skip-hooks (aprovação explícita) o conclui", async () => {
    const r = dirtyDocsRepo();
    mkdirSync(path.join(r.root, ".githooks"), { recursive: true });
    writeFileSync(path.join(r.root, ".githooks/pre-commit"), "#!/bin/sh\necho 'bloqueado pelo hook do time' >&2\nexit 1\n");
    chmodSync(path.join(r.root, ".githooks/pre-commit"), 0o755);
    r.git("config", "core.hooksPath", ".githooks");
    r.git("-c", "core.hooksPath=/dev/null", "add", "-A");
    r.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: hook do time");
    const state = await start(r, ["doc-hygiene"]);
    expect(state.status).toBe("commit_blocked");
    expect(state.blocked!.output).toContain("bloqueado pelo hook do time");
    expect(state.commits).toHaveLength(0);
    const sealed = await seal(r, true); // o usuário aprovou pular os hooks
    expect(sealed.state.commits.length).toBeGreaterThan(0);
    expect(sealed.state.status).toBe("sealed");
  });
});

describe("retomar depois de um commit bloqueado", () => {
  it("resume commita o que ficou preparado (com aprovação) e aplica as ações que não rodaram", async () => {
    const r = makeRepo();
    r.write("README.md", "# Projeto\nDescrição suficiente para não ser um documento vazio.");
    r.write("src/Unica.cs", "class U {}");
    r.write("docs/a.md", "# Doc A\nArquivo: velho/Unica.cs\n");
    r.write("c.bak", "x");
    mkdirSync(path.join(r.root, ".githooks"), { recursive: true });
    // hook do time que bloqueia qualquer commit que toque docs/
    writeFileSync(path.join(r.root, ".githooks/pre-commit"), "#!/bin/sh\nif git diff --cached --name-only | grep -q '^docs/'; then echo 'spec sem analise' >&2; exit 1; fi\n");
    chmodSync(path.join(r.root, ".githooks/pre-commit"), 0o755);
    r.git("config", "core.hooksPath", ".githooks");
    r.git("-c", "core.hooksPath=/dev/null", "add", "-A");
    r.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: base");
    const state = await start(r, ["doc-hygiene", "doc-refs", "doc-adr"]);
    expect(state.status).toBe("commit_blocked");
    expect(state.blocked!.action).toBe("doc-adr"); // a ordem é a do catálogo: doc-adr antes de doc-refs
    expect(state.not_applied).toEqual(["doc-refs"]);
    expect(readFileSync(path.join(r.root, "docs/a.md"), "utf8")).toContain("velho/Unica.cs"); // doc-refs ainda não rodou
    await expect(resumeFix({ root: r.root })).resolves.toMatchObject({ status: "commit_blocked" }); // sem aprovação, continua bloqueado
    const done = await resumeFix({ root: r.root, skipHooks: true });
    expect(done.status).toBe("started");
    expect(done.not_applied).toBeUndefined();
    expect(existsSync(path.join(r.root, "docs/adr/0001-registrar-decisoes-de-arquitetura.md"))).toBe(true);
    expect(readFileSync(path.join(r.root, "docs/a.md"), "utf8")).toContain("Arquivo: src/Unica.cs");
    expect(r.git("log", "--format=%B", "-n", "6")).toContain("Hooks pulados com aprovação explícita");
    expect(sha(r, "main")).toBe(state.base_commit);
    const sealed = await seal(r);
    expect(sealed.state.status).toBe("sealed");
  });
});

describe("ações de Documentação", () => {
  it("doc-owners gera OWNERS a partir do CODEOWNERS, sem inventar nomes (D2 sobe)", async () => {
    const r = makeRepo();
    r.write(".github/CODEOWNERS", "* @org/time-a\n");
    r.write("OWNERS.md", "Mantenedores\nColoque aqui o nome do mantenedor 1\n");
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.commit("feat: inicial");
    await start(r, ["doc-owners"]);
    const content = readFileSync(path.join(r.root, "OWNERS.md"), "utf8");
    expect(content).toContain("- @org/time-a");
    expect(content).not.toMatch(/coloque aqui/i);
    const res = await seal(r);
    expect(res.state.baseline.criteria["D2"]).toBe(0);
    expect(res.state.after!.criteria["D2"]).toBe(2);
  });

  it("doc-adr + doc-index: o índice lista o que as outras ações criaram (D3, D5 e D6 não pioram)", async () => {
    const r = makeRepo();
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.write("docs/a.md", "# Documento A\nTexto de apoio com tamanho suficiente.");
    r.commit("feat: inicial");
    await start(r, ["doc-index", "doc-adr"]); // a ordem digitada não importa: o catálogo manda
    const index = readFileSync(path.join(r.root, "docs/README.md"), "utf8");
    expect(index).toContain("[Documento A](a.md)");
    expect(index).toContain("(adr/README.md)");
    const res = await seal(r);
    expect(res.state.after!.criteria["D3"]).toBe(2);
    expect(res.state.after!.criteria["D5"]).toBe(2);
    expect(res.state.after!.criteria["D6"]).toBe(2);
  });

  it("doc-index é idempotente: rodar de novo não muda nada", async () => {
    const r = makeRepo();
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.write("docs/a.md", "# Documento A\nTexto de apoio com tamanho suficiente.");
    r.commit("feat: inicial");
    await start(r, ["doc-index"]);
    await seal(r);
    finishFix({ root: r.root, decision: "merge" });
    expect(previewFixes({ root: r.root, actionIds: ["doc-index"], params: {} })).toEqual([]);
  });

  it("doc-refs corrige só referência com destino único; as ambíguas ficam como aviso", async () => {
    const r = makeRepo();
    r.write("src/Unica.cs", "class U {}");
    r.write("a/Dup.cs", "class D {}");
    r.write("b/Dup.cs", "class D {}");
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.\nArquivo: velho/Unica.cs\nArquivo: velho/Dup.cs\n");
    r.commit("feat: inicial");
    await start(r, ["doc-refs"]);
    const text = readFileSync(path.join(r.root, "README.md"), "utf8");
    expect(text).toContain("Arquivo: src/Unica.cs");
    expect(text).toContain("Arquivo: velho/Dup.cs");
  });

  it("doc-hygiene só remove lixo inequívoco; documento solto vira aviso e continua lá", async () => {
    const r = dirtyDocsRepo();
    r.write("PROMPT_PROXIMOS_PASSOS.md", "# Próximos passos\nTexto longo o bastante para não ser considerado vazio pelo coletor.");
    r.commit("docs: nota solta");
    const state = await start(r, ["doc-hygiene"]);
    expect(existsSync(path.join(r.root, "PROMPT_PROXIMOS_PASSOS.md"))).toBe(true);
    expect(state.notes.join(" ")).toContain("PROMPT_PROXIMOS_PASSOS.md");
  });
});

describe("adotar o SDD (port do sdd-bootstrap)", () => {
  function domainRepo(): FixtureRepo {
    const r = makeRepo();
    r.write("README.md", "# Pagamentos\nDescrição suficiente para não ser um documento vazio.");
    r.write("src/Domain/Rules/A.cs", "class A { }");
    r.write("src/Domain/Rules/B.cs", "class B { }");
    r.commit("feat: inicial");
    return r;
  }

  it("cria manifest, hooks executáveis, settings, .gitignore, README e skill-rascunho; devolve tarefas guiadas; não ativa hooks", async () => {
    const r = domainRepo();
    const state = await start(r, ["sdd-adopt"], { params: { rule_globs: "src/Domain/Rules/*", skill_slug: "pagamentos" } });
    const read = (p: string) => readFileSync(path.join(r.root, p), "utf8");

    const manifest = JSON.parse(read(".sdd/manifest.json"));
    expect(manifest).toMatchObject({ specsDir: "docs/specs", skillSlug: "sdd-pagamentos", skillPath: ".claude/skills/sdd-pagamentos/SKILL.md", ruleCodeGlobs: ["src/Domain/Rules/*"] });
    for (const h of HOOK_FILES) {
      expect(read(h.path)).toBe(h.content); // verbatim do sdd-gate-ia
      expect(statSync(path.join(r.root, h.path)).mode & 0o111).not.toBe(0);
    }
    expect(JSON.parse(read(".claude/settings.json")).hooks.PostToolUse[0].hooks[0].command).toContain("spec-change-guard.sh");
    expect(read(".gitignore")).toContain("docs/specs/.impact-reports/");
    expect(read("README.md")).toContain("<!-- sdd-bootstrap:readme-section -->");
    expect(read("README.md")).toContain("não incluído"); // sem CI por padrão
    expect(read(".claude/skills/sdd-pagamentos/SKILL.md")).toContain("name: sdd-pagamentos");
    expect(existsSync(path.join(r.root, ".github/workflows/spec-drift-check.yml"))).toBe(false);

    expect(state.guided_tasks.map((t) => t.id)).toEqual(["sdd-discovery", "sdd-skill"]);
    expect(state.guided_tasks[0]!.instructions).toContain("src/Domain/Rules/*");
    expect(state.guided_tasks[0]!.instructions).toContain("Arquivo: caminho");
    expect(state.post_steps.join(" ")).toContain("git config core.hooksPath .githooks");
    const hp = spawnSync("git", ["config", "core.hooksPath"], { cwd: r.root, encoding: "utf8" });
    expect(hp.stdout.trim()).toBe(""); // ativar é decisão à parte, fora da branch
  });

  it("não sobrescreve README, .gitignore e settings existentes: só acrescenta", async () => {
    const r = domainRepo();
    r.write(".gitignore", "node_modules/\n");
    r.write(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo x" }] }] } }));
    r.commit("chore: config");
    await start(r, ["sdd-adopt"]);
    expect(readFileSync(path.join(r.root, ".gitignore"), "utf8")).toMatch(/^node_modules\/\n/);
    const s = JSON.parse(readFileSync(path.join(r.root, ".claude/settings.json"), "utf8"));
    expect(s.permissions.allow).toEqual(["Bash(ls)"]);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(readFileSync(path.join(r.root, "README.md"), "utf8")).toMatch(/^# Pagamentos/);
  });

  it("repo que já tem SDD completo não recebe a ação (nem pelo README) e não aparece em 'fixes'", async () => {
    const r = domainRepo();
    await start(r, ["sdd-adopt"], { params: { rule_globs: "src/Domain/Rules/*" } });
    r.write("docs/specs/README.md", "# Specs\n[1](01.md)");
    r.write("docs/specs/01.md", "# 1\nArquivo: src/Domain/Rules/A.cs\nArquivo: src/Domain/Rules/B.cs\n");
    const skillPath = JSON.parse(readFileSync(path.join(r.root, ".sdd/manifest.json"), "utf8")).skillPath as string;
    r.write(skillPath, "---\nname: sdd-x\n---\nSkill de domínio já preenchida pelo time.\n");
    await seal(r, true);
    finishFix({ root: r.root, decision: "merge" });
    // o README ganha texto novo no modelo? mesmo assim, SDD já adotado não é oferecido de novo
    r.write("README.md", readFileSync(path.join(r.root, "README.md"), "utf8").replace("Camadas de interceptação", "Camadas (texto antigo)"));
    r.commit("docs: readme");
    expect(previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: {} })).toEqual([]);
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, groups: ["documentation"], outDir: mkdtempSync(path.join(tmpdir(), "rs-o-")) });
    expect(data.fixes.map((f) => f.id)).not.toContain("sdd-adopt");
  });

  it("nunca reescreve a seção SDD que o README já tem (ex.: a linha de CI do time) e descreve o CI conforme o repo", async () => {
    const r = domainRepo();
    r.write("README.md", "# P\n<!-- sdd-bootstrap:readme-section -->\n## Specs\n- **CI** (`.github/workflows/spec-drift-check.yml`): do time.\n<!-- /sdd-bootstrap:readme-section -->\n");
    r.commit("docs: readme");
    const item = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: {} })[0]!;
    expect(item.changes.find((c) => c.path === "README.md")).toBeUndefined();

    const withCi = domainRepo();
    withCi.write(".github/workflows/spec-drift-check.yml", "name: x\n");
    withCi.commit("ci: spec drift");
    await start(withCi, ["sdd-adopt"]);
    expect(readFileSync(path.join(withCi.root, "README.md"), "utf8")).toContain("**CI** (`.github/workflows/spec-drift-check.yml`)");
  });

  it("é idempotente e respeita manifest existente; core.hooksPath de outra ferramenta vira aviso, sem sobrescrever", async () => {
    const r = domainRepo();
    r.git("config", "core.hooksPath", ".husky");
    await start(r, ["sdd-adopt"], { params: { rule_globs: "src/Domain/Rules/*" } });
    await seal(r);
    finishFix({ root: r.root, decision: "merge" });
    const again = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: { specs_dir: "outra/pasta" } })[0]!;
    expect(again.changes).toEqual([]); // nada de arquivo a mudar
    expect(again.notes.join(" ")).toContain("já tem .sdd/manifest.json");
    expect(again.post_steps).toEqual([]);
    expect(r.git("config", "core.hooksPath").trim()).toBe(".husky");
  });

  it("os hooks portados funcionam de verdade: commit de spec sem análise é bloqueado, e SDD_SKIP libera", async () => {
    const r = domainRepo();
    await start(r, ["sdd-adopt"], { params: { rule_globs: "src/Domain/Rules/*" } });
    await seal(r, true);
    finishFix({ root: r.root, decision: "merge" });
    r.git("config", "core.hooksPath", ".githooks"); // ativação local, como o dev faria
    r.write("docs/specs/01.md", "# 1\nArquivo: src/Domain/Rules/A.cs\n");
    r.git("add", "docs/specs/01.md");
    const blocked = spawnSync("git", ["commit", "-m", "docs: spec"], { cwd: r.root, encoding: "utf8" });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("COMMIT BLOQUEADO");
    const ok = spawnSync("git", ["commit", "-m", "docs: spec"], { cwd: r.root, encoding: "utf8", env: { ...process.env, SDD_SKIP: "1" } });
    expect(ok.status).toBe(0);
    // e agora o gate 2 vigia o código citado pela spec
    r.write("src/Domain/Rules/A.cs", "class A { int x; }");
    r.git("add", "src/Domain/Rules/A.cs");
    const gate2 = spawnSync("git", ["commit", "-m", "feat: regra"], { cwd: r.root, encoding: "utf8" });
    expect(gate2.status).not.toBe(0);
    expect(gate2.stderr).toContain("citado por spec sem spec junto");
  });

  it("a nota de Documentação sobe depois de adotar o SDD com specs que citam as regras", async () => {
    const r = domainRepo();
    await start(r, ["sdd-adopt"], { params: { rule_globs: "src/Domain/Rules/*" } });
    // simula a tarefa guiada do Claude: specs vivas citando os arquivos de regra
    r.write("docs/specs/README.md", "# Specs\n\n| # | Doc |\n|---|---|\n| 01 | [Regras A e B](./01-regras.md) |\n");
    r.write("docs/specs/01-regras.md", "# Regras A e B\n\nDescreve o comportamento atual.\n\nArquivo: src/Domain/Rules/A.cs\nArquivo: src/Domain/Rules/B.cs\n");
    const res = await seal(r, true);
    expect(res.state.baseline.criteria["D7"]).toBeNull(); // sem globs na origem: não medido
    expect(res.state.after!.criteria["D7"]).toBe(2);
    expect(res.state.after!.criteria["D4"]).toBe(2);
    expect(res.data.panels[0]!.items.find((i) => i.label === "Manifest")!.status).toBe("ok");
    expect(res.state.after!.dimensions["documentation"]!).toBeGreaterThan(res.state.baseline.dimensions["documentation"]!);
  });
});

describe("completar um SDD já adotado (perímetro e specs faltantes)", () => {
  function adoptedRepo(): FixtureRepo {
    const r = makeRepo();
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.write(".sdd/manifest.json", JSON.stringify({ version: 1, projectName: "p", specsDir: "docs/specs", skillSlug: "sdd-p", skillPath: ".claude/skills/sdd-p/SKILL.md", ruleCodeGlobs: ["src/Rules/*"] }, null, 2) + "\n");
    r.write(".claude/skills/sdd-p/SKILL.md", "---\nname: sdd-p\n---\nSkill preenchida.\n");
    for (const h of HOOK_FILES) r.write(h.path, h.content);
    for (const f of ["src/Rules/A.cs", "src/Rules/B.cs", "src/Handlers/H1.cs", "src/Handlers/H2.cs", "src/Handlers/H3.cs"]) r.write(f, "class X { }");
    r.write("docs/specs/README.md", "# Specs\n[1](01.md)\n");
    r.write("docs/specs/01.md", "# 1\nArquivo: src/Rules/A.cs\nArquivo: src/Handlers/H1.cs\nArquivo: src/Handlers/H2.cs\n");
    r.commit("feat: sdd com perímetro estreito");
    return r;
  }

  it("a ação continua oferecida: amplia o perímetro (pastas que as specs já citam) e devolve a tarefa de specs faltantes", () => {
    const r = adoptedRepo();
    const item = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: {} })[0]!;
    const manifest = item.changes.find((c) => c.path === ".sdd/manifest.json");
    expect(manifest).toBeDefined();
    expect(item.notes.join(" ")).toContain("src/Handlers/*");
    const gap = item.guided.find((g) => g.id === "sdd-gap-specs")!;
    expect(gap.title).toContain("2 arquivos");
    expect(gap.instructions).toContain("src/Rules/B.cs");
    expect(gap.instructions).toContain("src/Handlers/H3.cs");
    expect(gap.instructions).not.toContain("src/Rules/A.cs"); // já citado
    expect(gap.instructions).toContain("rule_exclude_globs");
    expect(gap.targets).toEqual(expect.arrayContaining(["docs/specs/", "repo-score.policy.json"]));
  });

  it("rule_globs informado é somado ao perímetro; perimeter=none não mexe no manifest", () => {
    const r = adoptedRepo();
    const custom = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: { rule_globs: "src/Outros/*" } })[0]!;
    expect(custom.notes.join(" ")).toContain("src/Outros/*");
    const none = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: { perimeter: "none" } })[0]!;
    expect(none.changes.find((c) => c.path === ".sdd/manifest.json")).toBeUndefined();
  });

  it("ciclo completo: medir (20%) → ampliar perímetro + specs → recalcular na branch nova (100%)", async () => {
    const r = adoptedRepo();
    const state = await start(r, ["sdd-adopt"]);
    expect(JSON.parse(readFileSync(path.join(r.root, ".sdd/manifest.json"), "utf8")).ruleCodeGlobs).toEqual(["src/Rules/*", "src/Handlers/*"]);
    expect(state.guided_tasks.map((t) => t.id)).toEqual(["sdd-gap-specs"]);
    // simula a tarefa guiada: specs cobrindo B e H3
    r.write("docs/specs/02-complemento.md", "# 2\nArquivo: src/Rules/B.cs\nArquivo: src/Handlers/H3.cs\n");
    r.write("docs/specs/README.md", "# Specs\n[1](01.md)\n[2](02-complemento.md)\n");
    const res = await seal(r, true);
    expect(res.state.baseline.criteria["D7"]).toBe(0); // 1 de 5
    expect(res.state.after!.criteria["D7"]).toBe(2); // 5 de 5, todos no perímetro e citados
    expect(res.state.base_commit).toBe(sha(r, "main"));
  });
});

describe("segurança da escrita", () => {
  it("applyChanges recusa caminho absoluto, .., .git e symlink que escapa", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rs-apply-"));
    const outside = mkdtempSync(path.join(tmpdir(), "rs-out-"));
    try {
      symlinkSync(outside, path.join(root, "link"));
      const bad = ["../x.txt", "/etc/x", ".git/config", "a/../../x", "link/x.txt"];
      for (const p of bad) expect(() => applyChanges(root, [{ op: "create", path: p, content: "x" }]), p).toThrow(ApplyError);
      expect(existsSync(path.join(outside, "x.txt"))).toBe(false);
      expect(applyChanges(root, [{ op: "create", path: "ok/x.txt", content: "x" }])).toEqual(["ok/x.txt"]);
      expect(() => applyChanges(root, [{ op: "create", path: "ok/x.txt", content: "y" }])).toThrow(/já existe/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("sugestões no relatório", () => {
  it("analyze lista as ações aplicáveis, ordenadas pela melhoria potencial, com pré-requisitos", async () => {
    const r = dirtyDocsRepo();
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, groups: ["documentation"], outDir: mkdtempSync(path.join(tmpdir(), "rs-o-")) });
    const ids = data.fixes.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["sdd-adopt", "doc-hygiene", "doc-adr"]));
    const hygiene = data.fixes.find((f) => f.id === "doc-hygiene")!;
    expect(hygiene.kind).toBe("auto");
    expect(hygiene.potential!.gain_total).toBeGreaterThan(0);
    expect(hygiene.tokens).toBeNull();
    const gains = data.fixes.map((f) => f.potential?.gain_total ?? -1);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
    expect(data.fixes.find((f) => f.id === "sdd-adopt")!.requires.map((q) => q.tool)).toEqual(expect.arrayContaining(["git", "jq", "claude"]));
    expect(data.fixes.every((f) => f.group === "documentation")).toBe(true);
  });

  it("grupos fora do escopo não geram sugestões", async () => {
    const r = dirtyDocsRepo();
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, groups: ["security"], outDir: mkdtempSync(path.join(tmpdir(), "rs-o-")) });
    expect(data.fixes).toEqual([]);
  });
});

void execFileSync;
void FixError;
