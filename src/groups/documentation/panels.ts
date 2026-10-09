import type { Ctx } from "../../collectors/context.js";
import { hasCommand } from "../../util/proc.js";
import type { Panel, PanelItem } from "../types.js";
import { ruleUniverse } from "./collectors/d7-specs-rules.js";
import { lintSpecs } from "./sdd/discovery/lint.js";
import { getDocIndex } from "./shared/docs-set.js";
import { readManifest } from "./shared/manifest.js";

export const SDD_HOOK_FILES = [".githooks/pre-commit", ".githooks/sdd-analyze", ".githooks/post-commit", ".githooks/pre-push", ".claude/hooks/spec-change-guard.sh"];

export interface SddHealth {
  adopted: boolean;
  items: PanelItem[];
}

export function sddHealth(ctx: Ctx): SddHealth {
  const items: PanelItem[] = [];
  const m = readManifest(ctx);
  const hooksPresent = SDD_HOOK_FILES.filter((h) => ctx.files.includes(h));
  const adopted = m.state !== "missing" || hooksPresent.length > 0;

  if (m.state === "missing") items.push({ label: "Manifest", status: adopted ? "fail" : "info", detail: ".sdd/manifest.json não existe" });
  else if (m.state === "invalid") items.push({ label: "Manifest", status: "fail", detail: m.reason });
  else items.push({ label: "Manifest", status: "ok", detail: `specs em ${m.manifest.specsDir}, skill ${m.manifest.skillSlug}` });
  if (!adopted) return { adopted, items: [{ label: "SDD", status: "info", detail: "ainda não adotado neste repo (sem manifest nem hooks)" }] };

  if (m.state === "ok") {
    const idx = getDocIndex(ctx);
    const dir = m.manifest.specsDir.replace(/\/+$/, "") + "/";
    const specs = idx.docs.filter((d) => d.rel.startsWith(dir));
    items.push(
      specs.length === 0
        ? { label: "Specs", status: "fail", detail: `${m.manifest.specsDir}/ sem documentos` }
        : { label: "Specs", status: idx.fileSet.has(`${dir}README.md`) ? "ok" : "warn", detail: `${specs.length} documentos${idx.fileSet.has(`${dir}README.md`) ? ", com índice" : ", sem README.md de índice"}` },
    );
    const lint = lintSpecs(ctx, m.manifest.specsDir);
    if (lint.length > 0) {
      const errors = lint.filter((r) => r.issues.some((i) => i.level === "error")).length;
      const warns = lint.filter((r) => r.issues.length > 0 && !r.issues.some((i) => i.level === "error")).length;
      items.push({
        label: "Padrão das specs",
        status: errors > 0 ? "fail" : warns > 0 ? "warn" : "ok",
        detail: `${lint.length - errors - warns} de ${lint.length} conformes (4 blocos, até 120 linhas, ponteiros válidos)${errors || warns ? `; ${errors} com erro, ${warns} com aviso: repo-score sdd lint` : ""}`,
      });
    }
    let total = 0;
    let broken = 0;
    for (const d of specs) for (const r of idx.refs.get(d.rel) ?? []) (total += 1, r.resolved === null && (broken += 1));
    if (total > 0) items.push({ label: "Citações", status: broken === 0 ? "ok" : "warn", detail: `${total - broken} de ${total} referências válidas` });
    const u = ruleUniverse(ctx);
    if (u) {
      const known = u.declared.length + u.citedOutsidePerimeter.length;
      items.push({
        label: "Perímetro do manifest",
        status: u.citedOutsidePerimeter.length === 0 ? "ok" : u.declared.length / known >= 0.5 ? "warn" : "fail",
        detail: `${u.declared.length} de ${known} arquivos que o manifest ou as specs tratam como regra estão nos ruleCodeGlobs${u.citedOutsidePerimeter.length ? `; ${u.citedOutsidePerimeter.length} citados pelas specs ficam fora` : ""}`,
      });
      items.push({
        label: "Regras ligadas a specs",
        status: u.linked.length === u.universe.length ? "ok" : u.linked.length / u.universe.length >= 0.5 ? "warn" : "fail",
        detail: `${u.linked.length} de ${u.universe.length} arquivos de regra no perímetro e citados${u.siblings.length ? ` (inclui ${u.siblings.length} irmãos por heurística)` : ""}`,
      });
    } else items.push({ label: "Perímetro do manifest", status: "warn", detail: "ruleCodeGlobs vazio e nenhuma spec cita código: o gate só vigia arquivos já citados" });

    const skill = m.manifest.skillPath;
    const skillText = ctx.files.includes(skill) ? ctx.readText(skill) : null;
    items.push(
      skillText === null
        ? { label: "Skill do domínio", status: "fail", detail: `${skill} não existe` }
        : /\bTODO\b/.test(skillText)
          ? { label: "Skill do domínio", status: "warn", detail: `${skill} ainda é rascunho (contém TODO)` }
          : { label: "Skill do domínio", status: "ok", detail: skill },
    );
  }

  items.push({
    label: "Hooks versionados",
    status: hooksPresent.length === SDD_HOOK_FILES.length ? "ok" : hooksPresent.length === 0 ? "fail" : "warn",
    detail: `${hooksPresent.length} de ${SDD_HOOK_FILES.length} arquivos`,
  });
  const hooksPath = ctx.git(["config", "core.hooksPath"])?.trim() ?? "";
  items.push(
    hooksPath === ".githooks"
      ? { label: "Hooks ativos neste clone", status: "ok", detail: "core.hooksPath = .githooks" }
      : hooksPath
        ? { label: "Hooks ativos neste clone", status: "warn", detail: `core.hooksPath = ${hooksPath} (outra ferramenta de hooks; integre manualmente)` }
        : { label: "Hooks ativos neste clone", status: "fail", detail: "core.hooksPath não definido: rode git config core.hooksPath .githooks" },
  );
  const settings = ctx.files.includes(".claude/settings.json") ? ctx.readText(".claude/settings.json") : null;
  items.push(
    settings?.includes("spec-change-guard.sh")
      ? { label: "Hook de sessão do Claude Code", status: "ok", detail: ".claude/settings.json" }
      : { label: "Hook de sessão do Claude Code", status: "warn", detail: "spec-change-guard.sh não configurado em .claude/settings.json" },
  );
  items.push({ label: "jq", status: hasCommand("jq") ? "ok" : "fail", detail: hasCommand("jq") ? "disponível (os hooks dependem dele)" : "ausente: os hooks ficam inativos sem jq" });
  items.push({ label: "CLI claude", status: hasCommand("claude") ? "ok" : "warn", detail: hasCommand("claude") ? "disponível (sdd-analyze usa claude -p)" : "ausente: o sdd-analyze gera PENDING em vez do plano" });
  return { adopted, items };
}

export function documentationPanels(ctx: Ctx): Panel[] {
  return [{ group: "documentation", title: "SDD: saúde", items: sddHealth(ctx).items }];
}
