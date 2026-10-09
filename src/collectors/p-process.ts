import path from "node:path";
import type { Evidence } from "../schema/evidence.js";
import { capEvidence, jobEvidence, measured, notApplicable, round, unmeasured, type Collector } from "./context.js";

// --- P4: commits convencionais -----------------------------------------------------------

const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|tests|ci|build|perf|style|revert)(\([^)]+\))?!?: \S/;
const WINDOW = 200;
const MIN_COMMITS = 5;

export function isConventional(subject: string): boolean {
  return CONVENTIONAL.test(subject);
}

export const p4Commits: Collector = {
  ids: ["P4"],
  async run(ctx) {
    if (!ctx.isGit) return [unmeasured("P4", "o diretório não é um repositório git")];
    const out = ctx.git(["log", "--no-merges", `-n${WINDOW}`, "--format=%H%x09%s"]);
    if (out === null) return [unmeasured("P4", "não foi possível ler o histórico do git")];
    const commits = out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("\t");
        return { sha: l.slice(0, i), subject: l.slice(i + 1) };
      });
    if (commits.length < MIN_COMMITS) {
      return [unmeasured("P4", `histórico curto demais (${commits.length} commits sem merge; mínimo ${MIN_COMMITS})`)];
    }
    const bad = commits.filter((c) => !isConventional(c.subject));
    const pct = round(((commits.length - bad.length) / commits.length) * 100, 1);
    const evidence: Evidence[] =
      bad.length > 0
        ? capEvidence(bad.map((c) => ({ kind: "commit" as const, sha: c.sha, note: c.subject.slice(0, 120) })))
        : [{ kind: "commit", sha: commits[0]!.sha, note: `${commits.length} commits recentes, todos convencionais` }];
    return [measured("P4", pct, evidence)];
  },
};

// --- P5: versionamento central de dependências ---------------------------------------------

type CentralState = "present+no-divergence" | "present" | "absent";
const RANK: Record<CentralState, number> = { absent: 0, present: 1, "present+no-divergence": 2 };

function dotnetCentral(ctx: Parameters<Collector["run"]>[0]): { state: CentralState; evidence: Evidence[] } | null {
  const projects = ctx.files.filter((f) => /\.(cs|fs|vb)proj$/.test(f));
  if (projects.length < 2) return null;
  const props = ctx.files.find((f) => path.posix.basename(f) === "Directory.Packages.props");
  if (!props) {
    return { state: "absent", evidence: [{ kind: "file", path: projects[0]!, note: ".NET: sem Directory.Packages.props" }] };
  }
  const propsText = ctx.readText(props) ?? "";
  const enabled = /<ManagePackageVersionsCentrally>\s*true\s*</i.test(propsText);
  const divergent: Evidence[] = [];
  for (const proj of projects) {
    const text = ctx.readText(proj);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, idx) => {
      if (/<PackageReference\b[^>]*\bVersion\s*=/i.test(line) && !/VersionOverride/i.test(line)) {
        divergent.push({ kind: "file", path: proj, line: idx + 1, snippet: "PackageReference", note: "versão fora do Directory.Packages.props" });
      }
    });
  }
  if (!enabled) {
    return { state: "present", evidence: [{ kind: "file", path: props, note: ".NET: ManagePackageVersionsCentrally não habilitado" }] };
  }
  if (divergent.length > 0) return { state: "present", evidence: divergent };
  return { state: "present+no-divergence", evidence: [{ kind: "file", path: props, note: ".NET: versões centralizadas, sem divergência" }] };
}

function npmCentral(ctx: Parameters<Collector["run"]>[0]): { state: CentralState; evidence: Evidence[] } | null {
  const manifests = ctx.files.filter((f) => path.posix.basename(f) === "package.json");
  if (manifests.length < 2) return null;
  const root = manifests.find((m) => m === "package.json");
  const rootText = root ? ctx.readText(root) : null;
  let workspaces = false;
  try {
    workspaces = !!rootText && !!(JSON.parse(rootText) as { workspaces?: unknown }).workspaces;
  } catch {
    workspaces = false;
  }
  if (!workspaces && !ctx.files.includes("pnpm-workspace.yaml")) {
    return { state: "absent", evidence: [{ kind: "file", path: manifests[0]!, note: "npm: vários package.json sem workspaces" }] };
  }
  const versions = new Map<string, Map<string, string>>();
  for (const m of manifests) {
    const text = ctx.readText(m);
    if (!text) continue;
    try {
      const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      for (const section of ["dependencies", "devDependencies"]) {
        for (const [dep, v] of Object.entries(j[section] ?? {})) {
          if (v.startsWith("workspace:") || v.startsWith("file:")) continue;
          if (!versions.has(dep)) versions.set(dep, new Map());
          versions.get(dep)!.set(m, v);
        }
      }
    } catch {
      /* package.json inválido: ignora */
    }
  }
  const divergent: Evidence[] = [];
  for (const [dep, byFile] of versions) {
    if (new Set(byFile.values()).size > 1) {
      const [first] = [...byFile.keys()];
      divergent.push({ kind: "file", path: first!, snippet: dep, note: `npm: ${dep} com versões diferentes entre pacotes` });
    }
  }
  if (divergent.length > 0) return { state: "present", evidence: divergent };
  return { state: "present+no-divergence", evidence: [{ kind: "file", path: root ?? manifests[0]!, note: "npm: workspaces sem divergência de versões" }] };
}

function gradleCentral(ctx: Parameters<Collector["run"]>[0]): { state: CentralState; evidence: Evidence[] } | null {
  const builds = ctx.files.filter((f) => /^build\.gradle(\.kts)?$/.test(path.posix.basename(f)));
  if (builds.length < 2) return null;
  const catalog = ctx.files.find((f) => f.endsWith("gradle/libs.versions.toml"));
  return catalog
    ? { state: "present", evidence: [{ kind: "file", path: catalog, note: "Gradle: version catalog presente" }] }
    : { state: "absent", evidence: [{ kind: "file", path: builds[0]!, note: "Gradle: sem gradle/libs.versions.toml" }] };
}

export const p5CentralVersioning: Collector = {
  ids: ["P5"],
  async run(ctx) {
    const parts = [dotnetCentral(ctx), npmCentral(ctx), gradleCentral(ctx)].filter((p) => p !== null);
    if (parts.length === 0) {
      return [notApplicable("P5", "menos de 2 projetos por ecossistema: versionamento central não se aplica")];
    }
    const worst = parts.reduce((a, b) => (RANK[b.state] < RANK[a.state] ? b : a));
    const evidence = parts.filter((p) => p.state === worst.state).flatMap((p) => p.evidence);
    return [measured("P5", worst.state, capEvidence(evidence))];
  },
};

// --- P6: CODEOWNERS granular --------------------------------------------------------------

export function countCodeownersRules(text: string): number {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, "").trim())
    .filter((l) => l !== "" && !l.startsWith("#") && l.split(/\s+/).length >= 2).length;
}

export const p6Codeowners: Collector = {
  ids: ["P6"],
  async run(ctx) {
    const file = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"].find((f) => ctx.files.includes(f));
    if (!file) {
      return [measured("P6", 0, [jobEvidence("p6-codeowners", "nenhum CODEOWNERS em .github/, raiz ou docs/")])];
    }
    const text = ctx.readText(file);
    if (text === null) return [unmeasured("P6", `não foi possível ler ${file}`)];
    const rules = countCodeownersRules(text);
    return [measured("P6", rules, [{ kind: "file", path: file, line: 1, note: `${rules} regras` }])];
  },
};
