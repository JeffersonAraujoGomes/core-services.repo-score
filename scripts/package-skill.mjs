// Gera dist/repo-score.zip com a pasta completa da skill (SKILL.md + scripts/ + references/),
// pronta para importar pela interface do app (Configurações > Skills) ou publicar no Neon Skill Hub.
// O importador de um único .md copia só o SKILL.md e deixa a skill sem os scripts.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "skill");
for (const f of ["SKILL.md", "scripts/repo-score.mjs", "references/rubric.json", "references/provenance.json"]) {
  if (!existsSync(path.join(src, f))) {
    console.error(`faltou skill/${f}. Rode "npm run build" antes.`);
    process.exit(1);
  }
}
// `--release` (publicação no hub): só empacota um bundle construído de uma árvore limpa, para o commit registrado
// em references/provenance.json reproduzir o SHA-256. Sem a flag, um bundle de árvore suja é aceito (testes locais).
const provenance = JSON.parse(readFileSync(path.join(src, "references/provenance.json"), "utf8"));
if (process.argv.includes("--release") && provenance.dirty) {
  console.error("--release: o bundle foi construído de uma árvore com alterações não commitadas, então o commit registrado não o reproduz. Commite, rode `npm run build` e empacote de novo.");
  process.exit(1);
}
if (provenance.dirty) console.warn("aviso: bundle construído de árvore suja (não reproduzível a partir do commit); use --release para publicar.");
const stage = path.join(root, "dist", "stage");
const out = path.join(root, "dist", "repo-score.zip");
rmSync(path.join(root, "dist"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(src, path.join(stage, "repo-score"), { recursive: true });
try {
  execFileSync("zip", ["-r", "-X", out, "repo-score"], { cwd: stage, stdio: "pipe" });
} catch (e) {
  console.error('o comando "zip" não está disponível; compacte a pasta skill/ manualmente como repo-score/ dentro de um .zip.');
  process.exit(1);
}
rmSync(stage, { recursive: true, force: true });
console.log(`${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
