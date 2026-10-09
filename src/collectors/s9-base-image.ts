import path from "node:path";
import type { Evidence } from "../schema/evidence.js";
import { capEvidence, jobEvidence, measured, notApplicable, type Collector } from "./context.js";

export function isDockerfile(rel: string): boolean {
  const base = path.posix.basename(rel).toLowerCase();
  return base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile");
}

export interface FromLine {
  line: number;
  /** A palavra FROM como escrita no arquivo (para o trecho de evidência). */
  keyword: string;
  image: string;
  problem: string | null;
}

/** Linhas FROM de um Dockerfile e o que há de errado em cada uma (null = ok). */
export function analyzeDockerfile(text: string, approvedRegistries: string[]): FromLine[] {
  const args = new Map<string, string>();
  const stages = new Set<string>();
  const out: FromLine[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    const arg = /^ARG\s+([A-Za-z_]\w*)=(\S+)/i.exec(line);
    if (arg) args.set(arg[1] ?? "", (arg[2] ?? "").replace(/^["']|["']$/g, ""));
    const m = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!m) return;
    let image = m[1] ?? "";
    const alias = m[2];
    image = image.replace(/\$\{?(\w+)\}?/g, (_, name: string) => args.get(name) ?? `$${name}`);
    const stageRef = stages.has(image.toLowerCase());
    if (alias) stages.add(alias.toLowerCase());
    if (stageRef || image.toLowerCase() === "scratch") return;
    if (image.includes("$")) return; // ARG sem default: não dá para resolver estaticamente

    let problem: string | null = null;
    const digest = image.includes("@sha256:");
    const ref = image.split("@")[0] ?? image;
    const lastSegment = ref.split("/").pop() ?? ref;
    const tag = lastSegment.includes(":") ? lastSegment.split(":")[1] : undefined;
    if (!digest) {
      if (!tag) problem = "sem tag: resolve para :latest";
      else if (tag.toLowerCase() === "latest") problem = "tag :latest";
    }
    if (!problem && approvedRegistries.length > 0) {
      const registry = ref.includes("/") && /[.:]/.test(ref.split("/")[0] ?? "") ? ref.split("/")[0]! : "docker.io";
      if (!approvedRegistries.includes(registry)) problem = `registry não aprovado: ${registry}`;
    }
    out.push({ line: idx + 1, keyword: line.slice(0, 4), image, problem });
  });
  return out;
}

export const s9BaseImage: Collector = {
  ids: ["S9"],
  async run(ctx) {
    const dockerfiles = ctx.files.filter(isDockerfile);
    if (dockerfiles.length === 0) return [notApplicable("S9", "o repo não tem Dockerfile")];

    const evidence: Evidence[] = [];
    let froms = 0;
    for (const rel of dockerfiles) {
      const text = ctx.readText(rel);
      if (text === null) continue;
      for (const f of analyzeDockerfile(text, ctx.policy.approved_registries)) {
        froms += 1;
        if (f.problem) {
          evidence.push({ kind: "file", path: rel, line: f.line, snippet: f.keyword, note: `${f.image}: ${f.problem}` });
        }
      }
    }
    if (evidence.length === 0) {
      return [
        measured("S9", 0, [
          jobEvidence("s9-base-image", `${froms} imagens base em ${dockerfiles.length} Dockerfiles, todas fixadas`),
        ]),
      ];
    }
    return [measured("S9", evidence.length, capEvidence(evidence))];
  },
};
