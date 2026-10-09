import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analyze.js";
import { optimizePrompt } from "../src/remediation/prompt.js";
import { renderReport } from "../src/report/render.js";
import { cleanupFixtures, makeRepo } from "./fixture-repo.js";
import { RUBRIC_PATH } from "./helpers.js";

const homes: string[] = [];
afterAll(() => {
  cleanupFixtures();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(path.join(tmpdir(), "rs-opt-"));
  homes.push(d);
  return d;
};

describe("botão Otimizar nota", () => {
  it("o prompt aciona a skill com a ação e o repo, limita o escopo e usa a branch atual (só o SDD, nova)", () => {
    const p = optimizePrompt('/work/meu "repo"', { id: "doc-readme", group: "documentation", title: "README por app", criteria: ["D1"], kind: "guided", branch: "current" });
    expect(p.split("\n")[0]).toBe('/repo-score otimizar doc-readme "/work/meu \\"repo\\""');
    expect(p).toContain("Ação: doc-readme — README por app");
    expect(p).toContain("critérios: D1");
    expect(p).toContain("somente esta ação");
    expect(p).toContain("BRANCH ATUAL");
    expect(p).not.toContain("BRANCH NOVA (nunca");
    expect(p).toContain("minha confirmação");
    const sdd = optimizePrompt("/r", { id: "sdd-adopt", group: "documentation", title: "SDD", criteria: ["D7"], kind: "mixed", branch: "new" });
    expect(sdd).toContain("BRANCH NOVA");
    expect(sdd).toContain("MESMA branch");
    expect(optimizePrompt("/r", { id: "doc-owners", group: "documentation", title: "t", criteria: [], kind: "auto", branch: "current" })).toContain("0 tokens");
  });

  it("cada sugestão acionável traz o prompt do próprio ponto; o relatório tem o botão", async () => {
    const r = makeRepo();
    r.write("apps.yml", "apps:\n  - dir: pay\n");
    r.write("apps/pay/Dockerfile", "FROM scratch");
    r.write("README.md", "# Monorepo\nTexto suficiente de visão do produto.");
    r.commit("feat: a");
    const { data } = await analyze({ root: r.root, rubricPath: RUBRIC_PATH, outDir: home(), groups: ["documentation"] });
    expect(data.fixes.length).toBeGreaterThan(0);
    for (const f of data.fixes) {
      if (f.kind === "manual") expect(f.prompt).toBeNull();
      else {
        expect(f.prompt).toContain(`otimizar ${f.id} `);
        expect(f.prompt).toContain(data.meta.path);
        expect(f.prompt).toContain(`Ação: ${f.id} — ${f.title}`);
      }
    }
    const html = renderReport(data);
    expect(html).toContain("Otimizar nota");
    expect(html).toContain("branch atual");
  });
});
