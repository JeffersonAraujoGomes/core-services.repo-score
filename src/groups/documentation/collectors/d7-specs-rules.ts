import path from "node:path";
import type { Evidence } from "../../../schema/evidence.js";
import { capEvidence, jobEvidence, measured, round, unmeasured, type Collector, type Ctx } from "../../../collectors/context.js";
import { pathspecToRegex } from "../../../util/glob.js";
import { dirname, getDocIndex } from "../shared/docs-set.js";
import { readManifest } from "../shared/manifest.js";
import { classifyRuleFile, CODE_EXT, isRuleCandidate, isTestLike } from "../shared/rule-files.js";

export { isRuleCandidate };

export interface RuleGlobs {
  globs: string[];
  source: string;
}

export function ruleGlobs(ctx: Ctx): RuleGlobs {
  const m = readManifest(ctx);
  const fromManifest = m.state === "ok" ? m.manifest.ruleCodeGlobs : [];
  const globs = [...new Set([...fromManifest, ...ctx.policy.docs.rule_globs])];
  const source = [fromManifest.length ? ".sdd/manifest.json" : "", ctx.policy.docs.rule_globs.length ? "política (docs.rule_globs)" : ""].filter(Boolean).join(" + ");
  return { globs, source };
}

export function ruleFiles(ctx: Ctx, globs: string[]): string[] {
  const res = globs.map(pathspecToRegex);
  return ctx.files.filter((f) => CODE_EXT.test(f) && !isTestLike(f) && res.some((re) => re.test(f)));
}

/** Documentos que contam como "specs": a pasta do manifest, ou todos os docs se não há manifest. */
export function specDocs(ctx: Ctx): string[] {
  const idx = getDocIndex(ctx);
  const m = readManifest(ctx);
  if (m.state === "ok") {
    const dir = m.manifest.specsDir.replace(/\/+$/, "") + "/";
    const specs = idx.docs.filter((d) => d.rel.startsWith(dir)).map((d) => d.rel);
    if (specs.length) return specs;
  }
  return idx.docs.map((d) => d.rel);
}

/** Arquivos de código citados pelas specs (citação de pasta vale para os arquivos dentro dela) e quais specs os citam. */
export function citedCode(ctx: Ctx): Map<string, string[]> {
  const idx = getDocIndex(ctx);
  const out = new Map<string, Set<string>>();
  const add = (f: string, spec: string) => out.set(f, (out.get(f) ?? new Set()).add(spec));
  for (const spec of specDocs(ctx)) {
    for (const r of idx.refs.get(spec) ?? []) {
      if (!r.resolved) continue;
      if (idx.dirSet.has(r.resolved)) {
        for (const f of idx.fileSet) if (f.startsWith(r.resolved + "/") && CODE_EXT.test(f)) add(f, spec);
      } else if (CODE_EXT.test(r.resolved)) add(r.resolved, spec);
    }
  }
  return new Map([...out].map(([f, s]) => [f, [...s].sort()]));
}

export interface RuleUniverse {
  globs: string[];
  source: string;
  /** Arquivos dentro do perímetro declarado (ruleCodeGlobs do manifest + política). */
  declared: string[];
  /** Código que as specs citam como regra (fora de testes, DTOs e interfaces), com as specs que o citam. */
  cited: Map<string, string[]>;
  /** Arquivos de comportamento nas mesmas pastas das regras conhecidas, sem citação (heurística). */
  siblings: string[];
  universe: string[];
  /** Ligadas nos dois sentidos: dentro do perímetro E citadas por spec. */
  linked: string[];
  declaredUncited: string[];
  citedOutsidePerimeter: string[];
  siblingsUncited: string[];
}

/**
 * Universo de regras do D7: o que o manifest declara + o que as próprias specs tratam como regra + os arquivos de
 * comportamento nas mesmas pastas. Uma regra só está "ligada" se está no perímetro do manifest E citada por uma spec;
 * citada fora do perímetro, ou dentro do perímetro sem spec, ou irmã sem nenhum dos dois, são lacunas.
 */
export function ruleUniverse(ctx: Ctx): RuleUniverse | null {
  const { globs, source } = ruleGlobs(ctx);
  const manifest = readManifest(ctx);
  if (globs.length === 0 && manifest.state !== "ok") return null;

  const excluded = ctx.policy.docs.rule_exclude_globs.map(pathspecToRegex);
  const isExcluded = (f: string) => excluded.some((re) => re.test(f));
  const declared = ruleFiles(ctx, globs).filter((f) => !isExcluded(f));
  const declaredSet = new Set(declared);
  const cited = new Map([...citedCode(ctx)].filter(([f]) => !isExcluded(f) && (isRuleCandidate(f) || declaredSet.has(f))));
  const known = new Set([...declared, ...cited.keys()]);
  const dirs = new Set([...known].map(dirname));
  const siblings = ctx.files.filter((f) => {
    if (isExcluded(f) || !dirs.has(dirname(f)) || known.has(f) || !isRuleCandidate(f)) return false;
    const text = ctx.readText(f);
    return text !== null && classifyRuleFile(f, text).rule; // mesma definição de "regra" da descoberta
  });
  const universe = [...new Set([...declared, ...cited.keys(), ...siblings])].sort();

  return {
    globs,
    source,
    declared,
    cited,
    siblings,
    universe,
    linked: declared.filter((f) => cited.has(f)),
    declaredUncited: declared.filter((f) => !cited.has(f)),
    citedOutsidePerimeter: [...cited.keys()].filter((f) => !declaredSet.has(f)).sort(),
    siblingsUncited: siblings.slice().sort(),
  };
}

/** Globs sugeridos para trazer ao perímetro as pastas das regras que as specs já citam (nunca aplicados sozinhos). */
export function suggestPerimeterGlobs(ctx: Ctx, u: RuleUniverse, limit = 12): string[] {
  const existing = u.globs.map(pathspecToRegex);
  const dirs = [...new Set(u.citedOutsidePerimeter.map(dirname))].filter((d) => d !== "" && !existing.some((re) => re.test(`${d}/x`)));
  const minimal = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + "/")));
  return minimal.sort().slice(0, limit).map((d) => `${d}/*`);
}

export const d7SpecsRules: Collector = {
  ids: ["D7"],
  async run(ctx) {
    const u = ruleUniverse(ctx);
    if (!u) {
      return [unmeasured("D7", "sem globs de regra de negócio: informe docs.rule_globs na política ou adote o SDD (.sdd/manifest.json → ruleCodeGlobs)")];
    }
    if (u.globs.length > 0 && u.declared.length === 0 && u.cited.size === 0) {
      return [unmeasured("D7", `os globs de regra (${u.source}) não casam nenhum arquivo de código`)];
    }
    if (u.universe.length === 0) return [unmeasured("D7", "nenhum arquivo de regra identificado (perímetro vazio e nenhuma spec cita código)")];

    const evidence: Evidence[] = [
      ...u.citedOutsidePerimeter.map((f) => ({ kind: "file" as const, path: f, line: 1, note: `citada por ${u.cited.get(f)![0]}, fora do perímetro (ruleCodeGlobs): o SDD não vigia este arquivo` })),
      ...u.declaredUncited.map((f) => ({ kind: "file" as const, path: f, line: 1, note: "no perímetro, mas nenhuma spec a cita" })),
      ...u.siblingsUncited.map((f) => ({ kind: "file" as const, path: f, line: 1, note: "irmã das regras conhecidas (mesma pasta, com lógica de negócio), sem spec nem perímetro (heurística)" })),
    ];
    const value = round((u.linked.length / u.universe.length) * 100, 1);
    if (evidence.length === 0) {
      evidence.push(jobEvidence("d7-specs-rules", `${u.universe.length} arquivos de regra (${u.source}), todos no perímetro e citados por specs`));
    } else {
      evidence.unshift(jobEvidence("d7-specs-rules", `universo de ${u.universe.length} arquivos: ${u.declared.length} no perímetro, ${u.cited.size} citados por specs, ${u.linked.length} ligados nos dois sentidos; ${u.siblings.length} irmãos (heurística)`));
    }
    return [measured("D7", value, capEvidence(evidence), u.siblings.length > 0 ? "medium" : "high")];
  },
};

export function coveredRuleFiles(ctx: Ctx, files: string[]): Set<string> {
  const cited = citedCode(ctx);
  return new Set(files.filter((f) => cited.has(f)));
}
