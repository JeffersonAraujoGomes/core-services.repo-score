import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d4PathRefs } from "../../src/groups/documentation/collectors/d4-path-refs.js";
import { previewFixes, startFix } from "../../src/remediation/engine.js";
import { RUBRIC_PATH } from "../helpers.js";
import { cleanupFixtures, makeRepo, run1, valueOf } from "../fixture-repo.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "rs-enc-"));
  process.env["REPO_SCORE_HOME"] = home;
});
afterAll(() => {
  cleanupFixtures();
  rmSync(home, { recursive: true, force: true });
});

const latin1 = (s: string) => Buffer.from(s, "latin1");

describe("arquivos que não são UTF-8 nunca são reescritos (evita corromper acentos)", () => {
  it("readText decodifica Latin-1 para análise; readTextStrict recusa", () => {
    const r = makeRepo();
    writeFileSync(path.join(r.root, "doc.md"), latin1("# Ingestão de Clientes\n"));
    const ctx = r.ctx();
    expect(ctx.readText("doc.md")).toBe("# Ingestão de Clientes\n");
    expect(ctx.readTextStrict("doc.md")).toBeNull();
    r.write("ok.md", "# Ingestão\n");
    expect(r.ctx().readTextStrict("ok.md")).toBe("# Ingestão\n");
  });

  it("D4 continua analisando um doc em Latin-1 (referências são lidas)", async () => {
    const r = makeRepo();
    r.write("src/A.cs", "class A {}");
    writeFileSync(path.join(r.root, "doc.md"), latin1("# Ingestão\nArquivo: src/A.cs\n"));
    expect(valueOf(await run1(d4PathRefs, r.ctx()))).toBe(100);
  });

  it("doc-refs não toca doc em Latin-1: os bytes ficam idênticos e o usuário é avisado", () => {
    const r = makeRepo();
    r.write("src/Unica.cs", "class U {}");
    const bytes = latin1("# Ingestão\nArquivo: velho/Unica.cs\n");
    writeFileSync(path.join(r.root, "doc.md"), bytes);
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.commit("feat: inicial");
    const items = previewFixes({ root: r.root, actionIds: ["doc-refs"], params: {} });
    expect(items[0]!.changes).toEqual([]);
    expect(items[0]!.notes.join(" ")).toContain("não está em UTF-8");
    expect(readFileSync(path.join(r.root, "doc.md")).equals(bytes)).toBe(true);
  });

  it("sdd-adopt não reescreve README em Latin-1, avisa, e segue com o resto", () => {
    const r = makeRepo();
    writeFileSync(path.join(r.root, "README.md"), latin1("# Projeto de Ingestão\n"));
    r.commit("feat: inicial");
    const item = previewFixes({ root: r.root, actionIds: ["sdd-adopt"], params: {} })[0]!;
    expect(item.changes.find((c) => c.path === "README.md")).toBeUndefined();
    expect(item.changes.find((c) => c.path === ".sdd/manifest.json")).toBeDefined();
    expect(item.notes.join(" ")).toContain("README.md: não está em UTF-8");
  });

  it("o BOM de um arquivo UTF-8 é preservado ao acrescentar linhas", async () => {
    const r = makeRepo();
    writeFileSync(path.join(r.root, ".gitignore"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("node_modules/\n")]));
    for (const f of ["a.bak", "b.bak", "c.orig", "d.swp", "e.bak"]) r.write(f, "x");
    r.write("README.md", "# P\nDescrição suficiente para não ser um documento vazio.");
    r.commit("feat: inicial");
    await startFix({ root: r.root, rubricPath: RUBRIC_PATH, actionIds: ["doc-hygiene"], params: {}, groups: ["documentation"] });
    const bytes = readFileSync(path.join(r.root, ".gitignore"));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toContain("*.bak");
    expect(bytes.toString("utf8")).toContain("node_modules/");
  });
});
