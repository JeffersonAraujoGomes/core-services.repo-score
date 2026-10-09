import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const src = (...p: string[]) => path.join(root, "src", ...p);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const importsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]!).filter((s) => s.startsWith("."));
const resolveImport = (file: string, spec: string) => path.relative(root, path.resolve(path.dirname(file), spec)).replace(/\.js$/, "");

describe("Documentação é um módulo separado dos demais grupos", () => {
  const docDir = src("groups", "documentation");
  const docFiles = files(docDir).filter((f) => f.endsWith(".ts"));

  it("o código do grupo só importa de si mesmo e da infraestrutura compartilhada", () => {
    const allowed = [
      /^src\/groups\/documentation\//,
      /^src\/collectors\/context$/, // tipos e helpers de coletor
      /^src\/remediation\/(types|changes)$/,
      /^src\/schema\//,
      /^src\/scorer\//, // biblioteca pura de pontuação
      /^src\/util\//,
      /^src\/groups\/types$/,
    ];
    const bad: string[] = [];
    for (const f of docFiles) {
      for (const spec of importsOf(f)) {
        const target = resolveImport(f, spec);
        if (!allowed.some((re) => re.test(target))) bad.push(`${path.relative(root, f)} → ${target}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("nenhum outro código de produção importa de dentro do grupo, exceto os pontos de composição", () => {
    const composition = new Set(["src/policy.ts", "src/groups/index.ts", "src/cli/main.ts"]); // pontos que compõem os módulos
    const bad: string[] = [];
    for (const f of files(src()).filter((x) => x.endsWith(".ts") && !x.startsWith(docDir))) {
      const rel = path.relative(root, f);
      if (composition.has(rel)) continue;
      for (const spec of importsOf(f)) if (/^src\/groups\/documentation\//.test(resolveImport(f, spec))) bad.push(`${rel} → ${resolveImport(f, spec)}`);
    }
    expect(bad).toEqual([]);
  });

  it("os testes do grupo ficam em tests/documentation e a instrução da skill em references/documentation.md", () => {
    expect(readdirSync(path.join(root, "tests", "documentation")).length).toBeGreaterThan(2);
    expect(existsSync(path.join(root, "skill", "references", "documentation.md"))).toBe(true);
  });
});

describe("templates do SDD vêm do core-services.sdd-gate-ia sem edição", () => {
  const dir = src("groups", "documentation", "sdd", "templates");
  const lock = JSON.parse(readFileSync(path.join(dir, "templates.lock.json"), "utf8")) as { commit: string | null; files: Record<string, string> };

  it("o hash de cada cópia confere com o selo (detecta edição manual)", () => {
    for (const [name, hash] of Object.entries(lock.files)) {
      expect(createHash("sha256").update(readFileSync(path.join(dir, name))).digest("hex"), name).toBe(hash);
    }
    expect(Object.keys(lock.files)).toHaveLength(8);
  });

  it("quando o repo irmão existe, as cópias estão em dia com ele", () => {
    const sibling = path.join(root, "..", "core-services.sdd-gate-ia", "sdd_bootstrap", "templates");
    if (!existsSync(sibling)) return;
    const map: Record<string, string> = {
      "pre-commit.sh": "hooks/pre-commit", "sdd-analyze.sh": "hooks/sdd-analyze", "post-commit.sh": "hooks/post-commit", "pre-push.sh": "hooks/pre-push",
      "spec-change-guard.sh": "hooks/spec-change-guard.sh", "skill-template.md": "skill/skill_template.md", "readme-section.md": "readme_section.md", "discovery-prompt.md": "discovery_prompt.md",
    };
    const stale = Object.entries(map).filter(([local, remote]) => readFileSync(path.join(dir, local), "utf8") !== readFileSync(path.join(sibling, remote), "utf8")).map(([l]) => l);
    expect(stale, "rode `npm run sync-sdd-templates`").toEqual([]);
  });
});
