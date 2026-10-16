import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_COLLECTORS } from "../src/groups/index.js";
import { loadRubric } from "./helpers.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

async function rebuild(): Promise<string> {
  const { bundleOptions } = (await import(pathToFileURL(path.join(root, "scripts/build.mjs")).href)) as { bundleOptions: (extra?: object) => object };
  const out = await build({ ...bundleOptions({ outfile: path.join(root, "skill/scripts/repo-score.mjs"), write: false }) } as never);
  return Buffer.from(out.outputFiles![0]!.contents).toString("utf8");
}

describe("bundle publicado: rastreável e sem caminho de commit", () => {
  it("o bundle versionado é exatamente o que o src/ gera (se falhar: npm run build)", async () => {
    const built = await rebuild();
    const committed = readFileSync(path.join(root, "skill/scripts/repo-score.mjs"));
    expect(sha(built)).toBe(sha(committed));
  });

  it("references/provenance.json registra o SHA-256 do bundle, o projeto e as ferramentas", () => {
    const p = JSON.parse(read("skill/references/provenance.json")) as Record<string, unknown>;
    expect(p["bundle_sha256"]).toBe(sha(readFileSync(path.join(root, "skill/scripts/repo-score.mjs"))));
    for (const k of ["project", "version", "commit", "esbuild", "typescript", "node"]) expect(p[k], k).toBeTruthy();
    expect(typeof p["dirty"]).toBe("boolean");
  });

  it("o SKILL.md traz o bloco de origem e integridade com o mesmo SHA-256", () => {
    const p = JSON.parse(read("skill/references/provenance.json")) as { bundle_sha256: string; commit: string };
    const md = read("skill/SKILL.md");
    expect(md).toContain("## Origem e integridade do bundle");
    expect(md).toContain(p.bundle_sha256);
    expect(md).toContain(p.commit);
    expect(md).toContain("node scripts/repo-score.mjs integrity");
  });

  it("o bundle não contém nenhuma chamada de git que commite, mescle ou reverta", async () => {
    const code = await rebuild();
    for (const forbidden of ['"commit", "-q"', '"--no-verify"', '"--no-ff"', '"revert", "--no-edit"', '"merge", "--abort"', '"revert", "--abort"']) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("o commit automático");
    expect(code).toContain("não existe nesta versão da skill: ela só cria, altera e remove arquivos");
    expect(code).toMatch(/COMMIT_PATHS_ENABLED = false/);
  });
});

describe("SKILL.md: o que esta versão mede segue os coletores e o padrão da skill", () => {
  it("cada critério com coletor aparece na lista certa (ativo por padrão × desativado)", () => {
    const md = read("skill/SKILL.md");
    const section = md.slice(md.indexOf("## O que esta versão mede"));
    const active = section.slice(section.indexOf("**Ativo por padrão"), section.indexOf("**Disponível, mas desativado"));
    const off = section.slice(section.indexOf("**Disponível, mas desativado"), section.indexOf("Os demais critérios"));
    const enabled = (JSON.parse(read("skill/references/groups.json")) as { enabled: string[] }).enabled;
    const rubric = loadRubric();
    const groupOf = new Map(rubric.dimensions.flatMap((d) => d.criteria.map((c) => [c.id, d.id] as const)));
    const ids = [...new Set(ALL_COLLECTORS.flatMap((c) => c.ids))].sort();
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      const inActive = new RegExp(`\\b${id}\\b`).test(active);
      const inOff = new RegExp(`\\b${id}\\b`).test(off);
      const isDefault = enabled.includes(groupOf.get(id)!);
      expect(isDefault ? inActive && !inOff : inOff && !inActive, `${id} (${groupOf.get(id)}) na lista ${isDefault ? "ativa" : "desativada"}`).toBe(true);
    }
  });
});
