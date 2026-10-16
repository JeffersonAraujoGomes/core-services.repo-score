// Instala as skills em ~/.claude/skills: repo-score (principal) e reposcore (atalho do comando).
// Cópia por padrão; --link cria links simbólicos (bom para desenvolver a skill).
// Uso: npm run install-skill [-- --link] [-- --skills-dir <pasta>] [-- --force]
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.resolve(flag("skills-dir") ?? path.join(os.homedir(), ".claude", "skills"));
const MARKER = ".installed-by-core-services.repo-score";
const LEGACY_MARKER = ".installed-by-core-services-repo-score"; // nome anterior do projeto: instalações antigas continuam reconhecidas
const PROJECT_DIRS = ["core-services.repo-score", "core-services-repo-score"];
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

const SKILLS = [
  { name: "repo-score", src: path.join(root, "skill") },
  { name: "reposcore", src: path.join(root, "skill-alias", "reposcore") },
];

for (const f of ["skill/SKILL.md", "skill/scripts/repo-score.mjs", "skill/references/rubric.json", "skill-alias/reposcore/SKILL.md"]) {
  if (!existsSync(path.join(root, f))) {
    console.error(`faltou ${f}. Rode "npm run build" antes.`);
    process.exit(1);
  }
}

const present = (p) => { try { lstatSync(p); return true; } catch { return false; } }; // inclui link quebrado

for (const { name, src } of SKILLS) {
  const dest = path.join(skillsDir, name);
  // Só substitui o que foi instalado por este script (ou com --force).
  if (present(dest)) {
    const st = lstatSync(dest);
    // link: aponta para esta pasta (ou para o mesmo projeto sob o nome antigo); cópia: tem o marcador atual ou o legado
    const pointsToProject = (target) => PROJECT_DIRS.some((d) => target.split(path.sep).includes(d)) && target.endsWith(path.relative(root, src));
    const ours = st.isSymbolicLink() ? path.resolve(path.dirname(dest), readlinkSync(dest)) === src || pointsToProject(path.resolve(path.dirname(dest), readlinkSync(dest))) : existsSync(path.join(dest, MARKER)) || existsSync(path.join(dest, LEGACY_MARKER));
    if (!ours && !args.includes("--force")) {
      console.error(`${dest} já existe e não foi instalado por este projeto. Use --force para substituir.`);
      process.exit(1);
    }
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(skillsDir, { recursive: true });
  if (args.includes("--link")) {
    symlinkSync(src, dest, "dir");
    console.log(`link: ${dest} -> ${src}`);
  } else {
    cpSync(src, dest, { recursive: true });
    writeFileSync(path.join(dest, MARKER), `${version}\n`);
    console.log(`copiada: ${dest}`);
  }
}
console.log('\nPronto. Se o Claude Code já estava aberto e a skill não aparecer, abra uma nova sessão.');
console.log('Use: /repo-score  (ou /reposcore)  ou escreva "repo score" / "analise o meu repo".');
