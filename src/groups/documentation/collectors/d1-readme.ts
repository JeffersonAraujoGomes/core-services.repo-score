import type { Evidence } from "../../../schema/evidence.js";
import { capEvidence, jobEvidence, measured, round, type Collector } from "../../../collectors/context.js";
import type { ReadmeSection } from "../policy.js";
import { detectApps, findInApp, type AppInfo } from "../shared/apps.js";

export function readmeHeadings(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l)?.[1])
    .filter((h): h is string => !!h);
}

/** Seções obrigatórias que nenhum título do README cobre. */
export function missingSections(text: string, required: ReadmeSection[]): ReadmeSection[] {
  const headings = readmeHeadings(text);
  return required.filter((s) => {
    const res = s.match.map((m) => new RegExp(m, "i"));
    return !headings.some((h) => res.some((re) => re.test(h)));
  });
}

export interface ReadmeStatus {
  app: AppInfo;
  readme: string | null;
  missing: ReadmeSection[];
}

export function readmeStatuses(ctx: Parameters<Collector["run"]>[0]): { statuses: ReadmeStatus[]; source: string } {
  const { apps, source } = detectApps(ctx);
  const required = ctx.policy.docs.readme_required_sections;
  const statuses = apps.map((app): ReadmeStatus => {
    const readme = findInApp(ctx, app, ["README.md", "README.markdown", "README"]);
    const text = readme ? ctx.readText(readme) : null;
    return { app, readme, missing: text === null ? required : missingSections(text, required) };
  });
  return { statuses, source };
}

export const d1Readme: Collector = {
  ids: ["D1"],
  async run(ctx) {
    const { statuses, source } = readmeStatuses(ctx);
    const ok = statuses.filter((s) => s.readme && s.missing.length === 0).length;
    const evidence: Evidence[] = [];
    for (const s of statuses) {
      if (s.readme && s.missing.length === 0) continue;
      const label = s.app.dir || s.app.name;
      evidence.push(
        s.readme
          ? { kind: "file", path: s.readme, line: 1, note: `${label}: faltam as seções ${s.missing.map((m) => m.label).join(", ")}` }
          : jobEvidence("d1-readme", `${label}: sem README`),
      );
    }
    if (evidence.length === 0) {
      evidence.push(jobEvidence("d1-readme", `${statuses.length} apps (${source}), todos com as seções obrigatórias`));
    }
    return [measured("D1", round((ok / statuses.length) * 100, 1), capEvidence(evidence))];
  },
};
