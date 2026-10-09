import type { Ctx } from "../../../collectors/context.js";
import { globToRegex } from "../../../util/glob.js";

export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export interface OwnerRule {
  pattern: string;
  owners: string[];
  line: number;
  re: RegExp;
}

export interface CodeownersFile {
  path: string;
  rules: OwnerRule[];
}

export function parseCodeowners(text: string): Omit<OwnerRule, "re">[] {
  const out: Omit<OwnerRule, "re">[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) return;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && owners.length > 0) out.push({ pattern, owners, line: i + 1 });
  });
  return out;
}

export function loadCodeowners(ctx: Ctx): CodeownersFile | null {
  const path = CODEOWNERS_PATHS.find((p) => ctx.files.includes(p));
  const text = path ? ctx.readText(path) : null;
  if (!path || text === null) return null;
  return { path, rules: parseCodeowners(text).map((r) => ({ ...r, re: globToRegex(r.pattern) })) };
}

/** Regra vencedora para um caminho (a última que casa, como no GitHub). `dir` é tratado como pasta. */
export function ownersFor(co: CodeownersFile, dir: string): OwnerRule | null {
  const probe = dir === "" ? "" : `${dir}/x`;
  let hit: OwnerRule | null = null;
  for (const r of co.rules) {
    if (r.pattern === "*" || r.re.test(probe) || (dir !== "" && r.re.test(dir))) hit = r;
  }
  return hit;
}
