// Copia os templates do SDD do projeto core-services.sdd-gate-ia (fonte única) para
// src/groups/documentation/sdd/templates/, sem editar o conteúdo, e grava templates.lock.json
// com o commit de origem e o hash de cada arquivo. Um teste falha se alguém editar uma cópia à mão.
// Uso: node scripts/sync-sdd-templates.mjs [--from <pasta do sdd-gate-ia>]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const from = path.resolve(args[args.indexOf("--from") + 1] ?? path.join(root, "..", "core-services.sdd-gate-ia"));
const srcDir = path.join(from, "sdd_bootstrap", "templates");
const dstDir = path.join(root, "src", "groups", "documentation", "sdd", "templates");

// origem (relativa a templates/) -> nome local (com extensão, para o loader de texto do esbuild)
const FILES = {
  "hooks/pre-commit": "pre-commit.sh",
  "hooks/sdd-analyze": "sdd-analyze.sh",
  "hooks/post-commit": "post-commit.sh",
  "hooks/pre-push": "pre-push.sh",
  "hooks/spec-change-guard.sh": "spec-change-guard.sh",
  "skill/skill_template.md": "skill-template.md",
  "readme_section.md": "readme-section.md",
  "discovery_prompt.md": "discovery-prompt.md",
};

if (!existsSync(srcDir)) {
  console.error(`templates não encontrados em ${srcDir}. Use --from <pasta do core-services.sdd-gate-ia>.`);
  process.exit(1);
}
mkdirSync(dstDir, { recursive: true });
const lock = { source: "core-services.sdd-gate-ia", commit: null, files: {} };
try {
  lock.commit = execFileSync("git", ["-C", from, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  /* sem git: segue sem commit */
}
for (const [src, dst] of Object.entries(FILES)) {
  copyFileSync(path.join(srcDir, src), path.join(dstDir, dst));
  lock.files[dst] = createHash("sha256").update(readFileSync(path.join(dstDir, dst))).digest("hex");
}
writeFileSync(path.join(dstDir, "templates.lock.json"), JSON.stringify(lock, null, 2) + "\n");
console.log(`${Object.keys(FILES).length} templates sincronizados de ${from} (${lock.commit?.slice(0, 8) ?? "sem commit"})`);
