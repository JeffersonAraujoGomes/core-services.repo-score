import path from "node:path";
import type { Ctx } from "../../../../collectors/context.js";
import { pathspecToRegex } from "../../../../util/glob.js";
import { classifyRuleFile, isRuleCandidate } from "../../shared/rule-files.js";
import { detectApps } from "../../shared/apps.js";
import { dirname } from "../../shared/docs-set.js";
import { audienceOfFile, audienceOfFiles, type Audience } from "../audience.js";
import { SPEC_BUDGET } from "../spec-standard.js";
import { docApp, inventoryDocs, slug, stem, type DocCandidate } from "./inventory.js";
import { discoverGlossaryFiles, discoverRuleFiles, symbolIndex, type RuleFile } from "./rules.js";

export type SpecKind = "visao-geral" | "glossario" | "orquestracao" | "regra" | "convertida";

export interface PlannedSpec {
  id: string;
  file: string;
  title: string;
  kind: SpecKind;
  /** BUS = regra de negócio (linguagem de produto); ENG = componente técnico. Vai no nome do arquivo e no título. */
  audience: Audience;
  app: string | null;
  /** Spec-mãe (orquestração) à qual esta se liga. */
  parent: string | null;
  /** Ponteiros `Arquivo:` definidos pelo plano (pré-requisito do SDD). */
  pointers: string[];
  /** Documentos existentes usados como fonte (absorvidos ou convertidos). */
  sourceDocs: string[];
  /** Recorte quando um arquivo grande é dividido em partes. */
  subtopic: string | null;
  codeLines: number;
  codeChars: number;
  docTokens: number;
  /** Importância relativa (soma das densidades), para priorizar se o orçamento apertar. */
  weight: number;
  notes: string[];
}

export interface SpecPlan {
  specsDir: string;
  specs: PlannedSpec[];
  /** Specs que ficaram fora do orçamento desta rodada. */
  deferred: { id: string; title: string; reason: string }[];
  docs: { path: string; convertible: boolean; reason: string; destination: string | null; tokens: number; signal: DocCandidate["signal"] }[];
  /** Perímetro (ruleCodeGlobs) derivado dos ponteiros do plano. */
  globs: string[];
  apps: { dir: string; name: string; ruleFiles: number; planned: number }[];
  stats: { ruleFiles: number; plumbingSkipped: number; lowSkipped: number; docsFound: number; docsConvertible: number };
}

const DOC_SPLIT_TOKENS = 1_500;
const pad = (n: number) => String(n).padStart(2, "0");
const human = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim();

function splitFile(f: RuleFile): { subtopic: string; lines: number }[] {
  const k = Math.ceil(f.lines / SPEC_BUDGET.splitCodeLines);
  const per = Math.ceil(Math.max(f.methods.length, 1) / k);
  return Array.from({ length: k }, (_, i) => {
    const chunk = f.methods.slice(i * per, (i + 1) * per);
    return { subtopic: `parte ${i + 1} de ${k}${chunk.length ? `: ${chunk.slice(0, 5).join(", ")}${chunk.length > 5 ? "…" : ""}` : ""}`, lines: Math.round(f.lines / k) };
  });
}

/** Documento grande vira várias specs, por grupos de seções (ou por partes iguais se não há seções). */
function splitDoc(text: string, tokens: number): { subtopic: string | null; tokens: number }[] {
  const k = Math.max(2, Math.ceil(tokens / 1_200));
  const headings = [...text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!.replace(/^\d+(\.\d+)*\.?\s*/, ""));
  const per = Math.ceil(headings.length / k);
  return Array.from({ length: k }, (_, i) => {
    const chunk = headings.slice(i * per, (i + 1) * per);
    return { subtopic: chunk.length ? `seções: ${chunk.slice(0, 4).join("; ")}${chunk.length > 4 ? "…" : ""}` : `parte ${i + 1} de ${k}`, tokens: Math.round(tokens / k) };
  });
}

function themeKey(rel: string, appDir: string): string {
  const parts = (appDir ? rel.slice(appDir.length + 1) : rel).split("/");
  return [parts[0], ...parts.slice(1, -1).slice(0, 2)].filter(Boolean).join("/");
}

/** Identificadores citados no documento que o código define (ponto de ligação documento → código). */
function docPointers(text: string, index: Map<string, string[]>, ruleFiles: Set<string>): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_][\w.]{5,})`/g)) ids.add(m[1]!.split(".").pop()!);
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){1,})\b/g)) ids.add(m[1]!);
  const score = new Map<string, number>();
  for (const id of ids) for (const f of index.get(id) ?? []) score.set(f, (score.get(f) ?? 0) + (ruleFiles.has(f) ? 2 : 1));
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
}

/** Pastas mínimas (`dir/*`) que cobrem os ponteiros de código: vira o ruleCodeGlobs do manifest. */
function perimeterGlobs(files: string[], limit = 20): string[] {
  const dirs = [...new Set(files.map(dirname))].filter((d) => d !== "");
  const minimal = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + "/")));
  return minimal.sort().slice(0, limit).map((d) => `${d}/*`);
}

export function buildSpecPlan(ctx: Ctx, opts: { maxSpecs?: number; specsDir?: string } = {}): SpecPlan {
  const specsDir = opts.specsDir ?? "docs/specs";
  const maxSpecs = opts.maxSpecs ?? 60;
  const { apps } = detectApps(ctx);
  const docs = inventoryDocs(ctx);
  const index = symbolIndex(ctx);

  const specs: PlannedSpec[] = [];
  const stats = { ruleFiles: 0, plumbingSkipped: 0, lowSkipped: 0, docsFound: docs.length, docsConvertible: docs.filter((d) => d.convertible).length };
  const appSummary: SpecPlan["apps"] = [];
  const allRuleFiles = new Set<string>();
  const fileName = (id: string, audience: Audience, title: string) => `${id}-${audience}-${slug(title)}.md`;
  const newSpec = (s: Omit<PlannedSpec, "file" | "notes" | "weight" | "codeLines" | "codeChars" | "docTokens" | "sourceDocs" | "subtopic" | "parent" | "app" | "audience"> & Partial<PlannedSpec>): PlannedSpec => ({
    audience: audienceOfFiles(s.pointers),
    app: null,
    parent: null,
    sourceDocs: [],
    subtopic: null,
    codeLines: 0,
    codeChars: 0,
    docTokens: 0,
    weight: 0,
    notes: [],
    ...s,
    file: fileName(s.id, s.audience ?? audienceOfFiles(s.pointers), s.title),
  });

  let appNo = 2;
  for (const app of apps) {
    const found = discoverRuleFiles(ctx, app.dir || null);
    stats.ruleFiles += found.rules.length;
    stats.plumbingSkipped += found.skippedPlumbing;
    stats.lowSkipped += found.skippedLow;
    found.rules.forEach((r) => allRuleFiles.add(r.path));
    if (found.rules.length === 0) {
      appSummary.push({ dir: app.dir, name: app.name, ruleFiles: 0, planned: 0 });
      continue;
    }

    const id = pad(appNo++);
    const orchestration = newSpec({
      id,
      title: `Visão do app ${app.name}`,
      kind: "orquestracao",
      audience: "BUS",
      app: app.dir,
      pointers: found.rules.slice(0, 2).map((r) => r.path),
      weight: found.rules.slice(0, 2).reduce((s, r) => s + r.density, 0),
    });
    specs.push(orchestration);

    const themes = new Map<string, RuleFile[]>();
    // negócio e engenharia nunca dividem a mesma spec: o tema é (pasta, público)
    for (const r of found.rules) {
      const key = `${audienceOfFile(r.path)}|${themeKey(r.path, app.dir)}`;
      themes.set(key, [...(themes.get(key) ?? []), r]);
    }

    let k = 1;
    const sub = (title: string, files: RuleFile[], subtopic: string | null, lines: number) => {
      const s = newSpec({
        id: `${id}.${k++}`,
        title,
        kind: "regra",
        app: app.dir,
        parent: id,
        pointers: files.map((f) => f.path),
        subtopic,
        codeLines: lines,
        codeChars: files.reduce((n, f) => n + f.chars, 0) / (subtopic ? Math.max(1, Number(/de (\d+)/.exec(subtopic)?.[1] ?? 1)) : 1),
        weight: files.reduce((n, f) => n + f.density, 0),
      });
      specs.push(s);
    };

    for (const [key, files] of [...themes].sort((a, b) => a[0].localeCompare(b[0]))) {
      const theme = key.slice(key.indexOf("|") + 1);
      const label = human(theme.split("/").slice(-1)[0] ?? theme);
      let cur: RuleFile[] = [];
      let curLines = 0;
      const flush = () => {
        if (cur.length === 0) return;
        const names = cur.map((f) => human(stem(f.path)));
        sub(cur.length === 1 ? names[0]! : `${names[0]} e correlatos (${cur.length} arquivos de ${label})`, cur, null, curLines);
        cur = [];
        curLines = 0;
      };
      for (const f of files) {
        if (f.lines > SPEC_BUDGET.maxCodeLines) {
          flush();
          for (const part of splitFile(f)) sub(`${human(stem(f.path))} — ${part.subtopic}`, [f], part.subtopic, part.lines);
        } else {
          if (cur.length >= SPEC_BUDGET.maxPointers - 1 || curLines + f.lines > SPEC_BUDGET.maxCodeLines) flush();
          cur.push(f);
          curLines += f.lines;
        }
      }
      flush();
    }
    appSummary.push({ dir: app.dir, name: app.name, ruleFiles: found.rules.length, planned: k - 1 });
  }

  // Documentos existentes. Uma spec de código absorve no máximo UM documento pequeno; os demais viram specs
  // convertidas próprias, e documento grande é quebrado por seções (nunca um arquivo grande com regra complexa).
  const docSpecs = new Map<string, PlannedSpec[]>();
  const docRowsBase: Omit<SpecPlan["docs"][number], "destination">[] = [];
  for (const d of docs) {
    const row = { path: d.path, convertible: d.convertible, reason: d.reason, tokens: d.tokens, signal: d.signal };
    docRowsBase.push(row);
    if (!d.convertible) continue;
    const text = ctx.readText(d.path) ?? "";
    const pointers = docPointers(text, index, allRuleFiles);
    const small = d.tokens <= DOC_SPLIT_TOKENS;
    const target = small ? specs.find((s) => s.kind === "regra" && s.sourceDocs.length === 0 && s.pointers.some((p) => pointers.includes(p))) : undefined;
    if (target) {
      target.sourceDocs.push(d.path);
      target.docTokens += d.tokens;
      target.notes.push(`converte ${path.posix.basename(d.path)} (fonte já escrita: menos código a ler)`);
      docSpecs.set(d.path, [target]);
      continue;
    }
    const appOf = docApp(d.path);
    const parent = specs.find((s) => s.kind === "orquestracao" && s.app === appOf);
    const parts = small ? [{ subtopic: null as string | null, tokens: d.tokens }] : splitDoc(text, d.tokens);
    const pointerChars = pointers.reduce((n, p) => n + (ctx.readText(p)?.length ?? 0), 0);
    const base = human(stem(d.path)).toLowerCase().replace(/^./, (c) => c.toUpperCase());
    const made = parts.map((part, i) => {
      const spec = newSpec({
        id: parent ? `${parent.id}.tmp${specs.length}` : pad(appNo++),
        title: parts.length > 1 ? `${base} — parte ${i + 1} de ${parts.length}` : base,
        kind: "convertida",
        audience: pointers.length ? audienceOfFiles(pointers) : "BUS",
        app: appOf,
        parent: parent?.id ?? null,
        pointers,
        sourceDocs: [d.path],
        subtopic: part.subtopic,
        docTokens: part.tokens,
        codeChars: pointerChars / parts.length,
        weight: d.density * 3,
      });
      if (pointers.length === 0) spec.notes.push("nenhum identificador do documento foi achado no código: os ponteiros precisam ser definidos na conversão (obrigatório)");
      specs.push(spec);
      return spec;
    });
    docSpecs.set(d.path, made);
  }

  // renumera as convertidas em sequência dentro de cada app
  for (const o of specs.filter((s) => s.kind === "orquestracao")) {
    let n = specs.filter((s) => s.parent === o.id && s.kind === "regra").length;
    for (const s of specs.filter((x) => x.parent === o.id && x.kind === "convertida")) {
      s.id = `${o.id}.${++n}`;
      s.file = fileName(s.id, s.audience, s.title);
    }
  }
  const docRows: SpecPlan["docs"] = docRowsBase.map((r) => {
    const made = docSpecs.get(r.path);
    return { ...r, destination: made ? (made.length > 1 ? `${made[0]!.id} a ${made[made.length - 1]!.id}` : made[0]!.id) : null };
  });

  const glossary = discoverGlossaryFiles(ctx).slice(0, 4);
  const head: PlannedSpec[] = [
    newSpec({ id: "00", title: "Visão geral", kind: "visao-geral", audience: "BUS", pointers: ctx.files.includes("apps.yml") ? ["apps.yml"] : ctx.files.includes("README.md") ? ["README.md"] : [], weight: 1_000 }),
  ];
  if (glossary.length) head.push(newSpec({ id: "01", title: "Glossário e invariantes", kind: "glossario", audience: "BUS", pointers: glossary, codeChars: glossary.reduce((n, f) => n + (ctx.readText(f)?.length ?? 0), 0), weight: 900 }));

  let all = [...head, ...specs];
  const deferred: SpecPlan["deferred"] = [];
  if (all.length > maxSpecs) {
    const keep = new Set(all.filter((s) => s.kind === "visao-geral" || s.kind === "glossario" || s.kind === "orquestracao").map((s) => s.id));
    const rest = all.filter((s) => !keep.has(s.id)).sort((a, b) => b.weight - a.weight);
    rest.slice(0, Math.max(0, maxSpecs - keep.size)).forEach((s) => keep.add(s.id));
    for (const s of all) if (!keep.has(s.id)) deferred.push({ id: s.id, title: s.title, reason: `fora do orçamento de ${maxSpecs} specs desta rodada (menor densidade de regra)` });
    all = all.filter((s) => keep.has(s.id));
  }

  const codePointers = all.filter((s) => ["regra", "orquestracao", "convertida"].includes(s.kind)).flatMap((s) => s.pointers).filter(isRuleCandidate);
  return { specsDir, specs: all, deferred, docs: docRows, globs: perimeterGlobs([...new Set([...codePointers, ...glossary])]), apps: appSummary, stats };
}

/** Arquivos de regra no perímetro derivado do plano: ligados (planejados) e irmãos (regra sem spec planejada). Mesma definição do D7. */
export function plannedSiblings(ctx: Ctx, plan: SpecPlan): { linked: string[]; siblings: string[] } {
  const res = plan.globs.map(pathspecToRegex);
  const planned = new Set(plan.specs.flatMap((s) => s.pointers).filter(isRuleCandidate));
  const linked: string[] = [];
  const siblings: string[] = [];
  for (const f of ctx.files) {
    if (!isRuleCandidate(f) || !res.some((re) => re.test(f))) continue;
    if (planned.has(f)) {
      linked.push(f);
      continue;
    }
    const text = ctx.readText(f);
    if (text !== null && classifyRuleFile(f, text).rule) siblings.push(f);
  }
  return { linked, siblings };
}

const planCache = new WeakMap<Ctx, Map<string, SpecPlan>>();

/** O plano é determinístico para o mesmo ctx e parâmetros; a análise o consulta várias vezes (sugestões, previsão, tarefas). */
export function buildSpecPlanCached(ctx: Ctx, opts: { maxSpecs?: number; specsDir?: string } = {}): SpecPlan {
  const key = `${opts.specsDir ?? "docs/specs"}|${opts.maxSpecs ?? ""}`;
  const byCtx = planCache.get(ctx) ?? new Map<string, SpecPlan>();
  planCache.set(ctx, byCtx);
  const hit = byCtx.get(key);
  if (hit) return hit;
  const plan = buildSpecPlan(ctx, opts);
  byCtx.set(key, plan);
  return plan;
}
