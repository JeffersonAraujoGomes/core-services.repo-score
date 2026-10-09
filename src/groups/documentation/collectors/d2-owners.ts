import type { Evidence } from "../../../schema/evidence.js";
import { capEvidence, jobEvidence, measured, round, type Collector, type Ctx } from "../../../collectors/context.js";
import { detectApps, findInApp, type AppInfo } from "../shared/apps.js";
import { loadCodeowners, ownersFor, type CodeownersFile } from "../shared/codeowners.js";

const PLACEHOLDER_PHRASE = /\bcoloque aqui\b|\bpreencha\b|\ba preencher\b|nome do mantenedor|\ba definir\b|fulano|seu nome|<[^>\n]+>|example\.com/i;
const PLACEHOLDER = { test: (l: string) => PLACEHOLDER_PHRASE.test(l) || /\b(TODO|TBD)\b/.test(l) };
const HANDLE = /@[\w.-]+(?:\/[\w.-]+)?|[\w.+-]+@[\w-]+\.[\w.-]+/g;

export interface OwnersFileInfo {
  maintainers: string[];
  handles: string[];
  placeholder: boolean;
}

export function parseOwnersFile(text: string): OwnersFileInfo {
  const body = text.replace(/<!--[\s\S]*?-->/g, "");
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^#{1,6}\s/.test(l));
  const placeholder = lines.some((l) => PLACEHOLDER.test(l));
  const hasHandle = (l: string) => new RegExp(HANDLE.source).test(l);
  const maintainers = lines.filter((l) => !PLACEHOLDER.test(l) && (/^([-*+]\s+|\d+[.)]\s+)/.test(l) || hasHandle(l)));
  const handles = [...body.matchAll(HANDLE)].map((m) => m[0].toLowerCase());
  return { maintainers, handles, placeholder };
}

export interface OwnersStatus {
  app: AppInfo;
  file: string | null;
  ok: boolean;
  reason: string | null;
  /** Donos que o CODEOWNERS atribui ao app (para sugerir o OWNERS). */
  codeowners: string[];
}

export function ownersStatuses(ctx: Ctx): { statuses: OwnersStatus[]; co: CodeownersFile | null } {
  const co = loadCodeowners(ctx);
  const { apps } = detectApps(ctx);
  const statuses = apps.map((app): OwnersStatus => {
    const file = findInApp(ctx, app, ["OWNERS.md", "OWNERS"]);
    const rule = co ? ownersFor(co, app.dir) : null;
    const codeowners = rule?.owners ?? [];
    const base = { app, file, codeowners };
    if (!file) return { ...base, ok: false, reason: "sem OWNERS.md" };
    const text = ctx.readText(file);
    if (text === null) return { ...base, ok: false, reason: "OWNERS ilegível" };
    const info = parseOwnersFile(text);
    if (info.placeholder) return { ...base, ok: false, reason: "OWNERS ainda tem o texto-modelo" };
    if (info.maintainers.length === 0) return { ...base, ok: false, reason: "OWNERS sem mantenedores" };
    if (!co) return { ...base, ok: false, reason: "o repo não tem CODEOWNERS" };
    if (!rule) return { ...base, ok: false, reason: "nenhuma regra do CODEOWNERS cobre o app" };
    const lower = rule.owners.map((o) => o.toLowerCase());
    const stray = info.handles.filter((h) => h.startsWith("@") && !lower.includes(h));
    if (stray.length) return { ...base, ok: false, reason: `OWNERS cita ${stray.join(", ")}, fora do CODEOWNERS` };
    return { ...base, ok: true, reason: null };
  });
  return { statuses, co };
}

export const d2Owners: Collector = {
  ids: ["D2"],
  async run(ctx) {
    const { statuses } = ownersStatuses(ctx);
    const ok = statuses.filter((s) => s.ok).length;
    const evidence: Evidence[] = [];
    for (const s of statuses) {
      if (s.ok) continue;
      const label = s.app.dir || s.app.name;
      evidence.push(
        s.file
          ? { kind: "file", path: s.file, line: 1, note: `${label}: ${s.reason}` }
          : jobEvidence("d2-owners", `${label}: ${s.reason}`),
      );
    }
    if (evidence.length === 0) evidence.push(jobEvidence("d2-owners", `${statuses.length} apps com OWNERS preenchido e coberto pelo CODEOWNERS`));
    return [measured("D2", round((ok / statuses.length) * 100, 1), capEvidence(evidence))];
  },
};
