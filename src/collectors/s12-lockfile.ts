import path from "node:path";
import type { Evidence } from "../schema/evidence.js";
import { capEvidence, measured, notApplicable, type Collector, type Ctx } from "./context.js";

type State = "locked" | "present" | "absent";
const RANK: Record<State, number> = { absent: 0, present: 1, locked: 2 };

interface Ecosystem {
  name: string;
  manifest: (base: string) => boolean;
  lockfiles: string[];
  /** Padrões, nos arquivos de build/CI, que provam restauração em modo locked. */
  locked: RegExp;
}

const ECOSYSTEMS: Ecosystem[] = [
  {
    name: "npm",
    manifest: (b) => b === "package.json",
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"],
    locked: /\bnpm\s+ci\b|--frozen-lockfile|--immutable\b|--ci\b/,
  },
  {
    name: ".NET",
    manifest: (b) => /\.(cs|fs|vb)proj$/.test(b),
    lockfiles: ["packages.lock.json"],
    locked: /--locked-mode|RestoreLockedMode/i,
  },
  {
    name: "Go",
    manifest: (b) => b === "go.mod",
    lockfiles: ["go.sum"],
    locked: /-mod=readonly|-mod=vendor|go\s+mod\s+verify/,
  },
  {
    name: "Gradle",
    manifest: (b) => /^build\.gradle(\.kts)?$/.test(b),
    lockfiles: ["gradle.lockfile"],
    locked: /--write-locks|dependencyLocking|lockAllConfigurations/,
  },
];

const CI_FILE = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|azure-pipelines[^/]*\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile|Dockerfile[^/]*|[^/]*\.Dockerfile|Makefile|[^/]+\.csproj|Directory\.Build\.(props|targets))$/;

function ciText(ctx: Ctx): string {
  return ctx.files
    .filter((f) => CI_FILE.test(f))
    .map((f) => ctx.readText(f) ?? "")
    .join("\n");
}

export function lockStateFor(
  eco: Ecosystem,
  manifestDir: string,
  fileSet: Set<string>,
  ci: string,
): { state: State; lock?: string } {
  // O lockfile pode estar na pasta do manifesto ou em qualquer ancestral (monorepo com lock na raiz).
  let dir = manifestDir;
  for (;;) {
    for (const l of eco.lockfiles) {
      const candidate = dir === "" ? l : `${dir}/${l}`;
      if (fileSet.has(candidate)) return { state: eco.locked.test(ci) ? "locked" : "present", lock: candidate };
    }
    if (dir === "") break;
    dir = path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir);
  }
  return { state: "absent" };
}

export const s12Lockfile: Collector = {
  ids: ["S12"],
  async run(ctx) {
    const fileSet = new Set(ctx.files);
    const ci = ciText(ctx);
    const evidence: Evidence[] = [];
    let worst: State | null = null;
    const ecosystems: string[] = [];

    for (const eco of ECOSYSTEMS) {
      const manifests = ctx.files.filter((f) => eco.manifest(path.posix.basename(f)));
      if (manifests.length === 0) continue;
      ecosystems.push(eco.name);
      let ecoState: State = "locked";
      let firstAbsent: string | null = null;
      let anyLock: string | undefined;
      for (const m of manifests) {
        const dir = path.posix.dirname(m) === "." ? "" : path.posix.dirname(m);
        const r = lockStateFor(eco, dir, fileSet, ci);
        if (RANK[r.state] < RANK[ecoState]) ecoState = r.state;
        if (r.state === "absent" && !firstAbsent) firstAbsent = m;
        if (r.lock) anyLock ??= r.lock;
      }
      if (worst === null || RANK[ecoState] < RANK[worst]) worst = ecoState;
      if (ecoState === "absent" && firstAbsent) {
        evidence.push({ kind: "file", path: firstAbsent, note: `${eco.name}: sem lockfile para este manifesto` });
      } else if (anyLock) {
        evidence.push({
          kind: "file",
          path: anyLock,
          note: `${eco.name}: lockfile ${ecoState === "locked" ? "com restauração em modo locked no CI" : "presente, sem modo locked comprovado no CI"}`,
        });
      }
    }

    if (worst === null) return [notApplicable("S12", "nenhum manifesto de dependências conhecido (npm, .NET, Go, Gradle)")];
    return [measured("S12", worst, capEvidence(evidence))];
  },
};
