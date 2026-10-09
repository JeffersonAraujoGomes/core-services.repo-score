import path from "node:path";
import type { Ctx } from "../../../collectors/context.js";
import { kebab, readForEdit, upsert } from "../../../remediation/changes.js";
import type { ActionPlan, FileChange, GuidedTask } from "../../../remediation/types.js";
import { ruleUniverse, suggestPerimeterGlobs, type RuleUniverse } from "../collectors/d7-specs-rules.js";
import { getDocIndex } from "../shared/docs-set.js";
import { MANIFEST_PATH, readManifest, type SddManifest } from "../shared/manifest.js";
import { suggestRuleGlobs } from "./detect.js";
import { mergeClaudeSettings, mergeGitignore, mergeReadmeSection } from "./merge.js";
import { HOOK_FILES, TEMPLATES } from "./templates.js";

const CI_LINE_NONE =
  "- **CI**: não incluído. A camada de CI do SDD foi descartada (a IP allow list da organização bloqueia os runners hospedados); a cobertura é local e depende de cada dev ativar os hooks.";
const CI_LINE_PRESENT =
  "- **CI** (`.github/workflows/spec-drift-check.yml`): anota o drift no PR (annotation + summary) — cobre quem não ativou os hooks. Não falha o merge.";

export const parseGlobs = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map((g) => g.trim()).filter(Boolean);

function render(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v), template);
}

/** Parte 1 do prompt de descoberta do sdd-bootstrap (specs vivas), reaproveitada verbatim nas instruções. */
function discoveryPart1(): string {
  const text = TEMPLATES.discoveryPrompt;
  const a = text.indexOf("## Parte 1");
  const b = text.indexOf("## Parte 2");
  return a >= 0 && b > a ? text.slice(a, b).trim() : text.trim();
}

export function discoveryInstructions(m: SddManifest): string {
  return [
    `Descoberta do SDD em ${m.projectName || "este repositório"}. Pasta de specs: \`${m.specsDir}/\`.`,
    "",
    discoveryPart1(),
    "",
    "## Manifesto",
    "",
    `O \`${MANIFEST_PATH}\` JÁ foi criado pelo repo-score; não o recrie. Se encontrar diretórios de regra de negócio que não estão em \`ruleCodeGlobs\`, acrescente-os preservando o formato do arquivo.`,
    `ruleCodeGlobs atuais: ${m.ruleCodeGlobs.length ? m.ruleCodeGlobs.map((g) => `\`${g}\``).join(", ") : "(vazio: defina a partir do que você encontrar)"}.`,
    "",
    "## Limites",
    "",
    `Escreva apenas em \`${m.specsDir}/\` e, se preciso, em \`${MANIFEST_PATH}\`. Não altere código, testes nem outros arquivos. Citações \`Arquivo: caminho\` relativas à raiz do repo, sem número de linha, e todas devem apontar para arquivos que existem. Não use marcadores TODO/TBD.`,
    "",
    "Ao terminar, informe: quantos documentos criou, a pasta de specs e os ruleCodeGlobs finais.",
  ].join("\n");
}

const MAX_LISTED = 60;

/** Instruções para cobrir com specs as regras que o SDD ainda não documenta (completar, não recomeçar). */
export function gapInstructions(m: SddManifest, u: RuleUniverse, extraTargets: string[]): string {
  const files = [...new Set([...u.declaredUncited, ...u.siblingsUncited])].sort();
  const shown = files.slice(0, MAX_LISTED);
  return [
    `Completar o SDD de ${m.projectName || "este repositório"}: há regras de negócio sem spec. Pasta de specs: \`${m.specsDir}/\`.`,
    "",
    `Arquivos sem citação em nenhuma spec (${files.length}${files.length > shown.length ? `, mostrando ${shown.length}` : ""}); "irmão" = achado por heurística nas pastas das regras conhecidas e pode não ser regra:`,
    ...shown.map((f) => `- \`${f}\`${u.declaredUncited.includes(f) ? " (no perímetro)" : " (irmão)"}`),
    "",
    "## Como proceder",
    "",
    `1. Leia o índice \`${m.specsDir}/README.md\` e 2 ou 3 specs existentes: siga a numeração, o idioma, o formato e a convenção \`Arquivo: caminho\` (nível de arquivo, sem linha, relativo à raiz do repo).`,
    "2. Para cada arquivo acima que **é** regra de negócio: documente o comportamento ATUAL (as-is) na spec do tema, ou crie uma nova spec (um tema por documento) se nenhuma serve, citando o arquivo; marque fragilidades com ⚠️ Risco. Registre cada novo documento no índice.",
    "3. Para cada arquivo que **não é** regra (infraestrutura, plumbing, DTO): não crie spec; liste-o em `docs.rule_exclude_globs` do `repo-score.policy.json` (crie o arquivo se não existir) e diga o motivo na resposta.",
    `4. Se a skill tiver um mapa spec → código, acrescente as linhas das specs novas no arquivo onde esse mapa vive (alvos permitidos abaixo).`,
    "5. Todas as citações devem apontar para arquivos que existem. Sem marcadores TODO/TBD.",
    "",
    `Altere somente: \`${m.specsDir}/\`, ${[...extraTargets, "repo-score.policy.json"].map((t) => `\`${t}\``).join(", ")}.`,
    "Ao terminar, informe: specs criadas ou alteradas, arquivos excluídos (e por quê) e arquivos que ficaram sem spec.",
  ].join("\n");
}

export function skillInstructions(m: SddManifest): string {
  return [
    `Preencha a skill de domínio do SDD em \`${m.skillPath}\` (hoje é um rascunho com TODOs).`,
    "",
    `Leia \`${m.specsDir}/\` (comece pelo README.md) e reescreva o arquivo mantendo o frontmatter \`name: ${m.skillSlug}\`, com \`description\` citando os temas de negócio reais das specs.`,
    "O corpo segue este roteiro: Fonte de verdade (link para o README das specs); Mapa rápido spec → código (tabela real, a partir das citações `Arquivo: caminho`); Casos de teste obrigatórios por tipo de mudança; Revisão de conflitos entre regras (checklist específico deste domínio, não genérico); Ciclo SDD detalhado; Princípios.",
    "Sem marcadores TODO/TBD no resultado. Só fatos verificáveis nas specs e no código; se algo não existir, não invente.",
    `Altere somente \`${m.skillPath}\`.`,
  ].join("\n");
}

export function planSdd(ctx: Ctx, params: Record<string, string>): ActionPlan | null {
  const notes: string[] = [];
  const postSteps: string[] = [];
  const changes: FileChange[] = [];
  const guided: GuidedTask[] = [];
  const push = (c: FileChange | null) => c && changes.push(c);

  const state = readManifest(ctx);
  if (state.state === "invalid") {
    return { changes: [], guided: [], notes: [`${MANIFEST_PATH} existe mas é inválido (${state.reason}). Corrija ou apague o arquivo e rode de novo.`], postSteps: [] };
  }

  const repoName = path.basename(ctx.root);
  let manifest: SddManifest;
  if (state.state === "ok") {
    manifest = state.manifest;
    if (params["specs_dir"] || params["skill_slug"]) {
      notes.push(`O repo já tem ${MANIFEST_PATH}; specs_dir e skill_slug foram ignorados (edite o manifest para mudá-los). rule_globs é somado ao perímetro existente.`);
    }
  } else {
    const slug = kebab(params["skill_slug"] || `sdd-${repoName.split(".").pop() ?? repoName}`).replace(/^(?!sdd-)/, "sdd-");
    manifest = {
      version: 1,
      projectName: params["project_name"] || repoName,
      specsDir: (params["specs_dir"] || "docs/specs").replace(/\/+$/, ""),
      skillSlug: slug,
      skillPath: `.claude/skills/${slug}/SKILL.md`,
      ruleCodeGlobs: parseGlobs(params["rule_globs"]),
    };
    push({ op: "create", path: MANIFEST_PATH, content: JSON.stringify(manifest, null, 2) + "\n", note: "contrato lido pelos hooks (jq)" });
    if (manifest.ruleCodeGlobs.length === 0) {
      const sug = suggestRuleGlobs(ctx);
      notes.push(
        "ruleCodeGlobs vazio: o gate só vigiará arquivos já citados pelas specs. " +
          (sug.length ? `Sugestões (confirme com o time): ${sug.map((s) => `${s.glob} (${s.files} arquivos)`).join("; ")}.` : "Nenhuma pasta de regras foi detectada automaticamente."),
      );
    }
  }

  for (const h of HOOK_FILES) push(upsert(ctx, h.path, h.content, { mode: "exec" }));

  const settingsPath = ".claude/settings.json";
  const sRead = readForEdit(ctx, settingsPath, notes);
  if (!sRead.skip) {
    const settings = mergeClaudeSettings(sRead.text);
    if (settings.changed) push(upsert(ctx, settingsPath, settings.content, { note: settings.note }));
    else if (!settings.note.includes("já configurado")) notes.push(settings.note);
  }

  const gRead = readForEdit(ctx, ".gitignore", notes);
  if (!gRead.skip) {
    const ignore = mergeGitignore(gRead.text, manifest.specsDir);
    if (ignore.changed) push(upsert(ctx, ".gitignore", ignore.content, { note: ignore.note }));
  }

  const section = render(TEMPLATES.readmeSection, {
    SPECS_DIR: manifest.specsDir,
    SKILL_SLUG: manifest.skillSlug,
    SKILL_PATH: manifest.skillPath,
    CI_LINE: ctx.files.includes(".github/workflows/spec-drift-check.yml") ? CI_LINE_PRESENT : CI_LINE_NONE,
  });
  const rRead = readForEdit(ctx, "README.md", notes);
  // Uma seção SDD que o time já tem no README nunca é reescrita (pode ter texto próprio, como a linha de CI); só se acrescenta quando falta.
  if (!rRead.skip && !(rRead.text ?? "").includes("<!-- sdd-bootstrap:readme-section -->")) {
    const readme = mergeReadmeSection(rRead.text, section, repoName);
    if (readme.changed) push(upsert(ctx, "README.md", readme.content, { note: readme.note }));
  }

  const idx = getDocIndex(ctx);
  const specsPrefix = `${manifest.specsDir}/`;
  const specsDocs = idx.docs.filter((d) => d.rel.startsWith(specsPrefix));
  if (specsDocs.length === 0 && !ctx.files.includes(`${specsPrefix}README.md`)) {
    push({
      op: "create",
      path: `${specsPrefix}README.md`,
      content: `# Specs — ${manifest.projectName}\n\nÍndice das especificações vivas (SDD) deste projeto. Ainda sem especificações: rode a descoberta do SDD (skill repo-score) ou crie um documento por tema de regra de negócio e liste-o aqui.\n`,
    });
  }

  const skillExists = ctx.files.includes(manifest.skillPath);
  const skillText = skillExists ? ctx.readText(manifest.skillPath) : null;
  push(upsert(ctx, manifest.skillPath, render(TEMPLATES.skillTemplate, { SKILL_SLUG: manifest.skillSlug, PROJECT_NAME: manifest.projectName, SPECS_DIR: manifest.specsDir }), { createOnly: true, note: "rascunho com TODOs: preencha com a tarefa guiada" }));

  const needsDiscovery = specsDocs.filter((d) => !/(^|\/)readme\.md$/i.test(d.rel)).length === 0;
  if (needsDiscovery) {
    guided.push({
      id: "sdd-discovery",
      title: "Descoberta: escrever as specs vivas",
      instructions: discoveryInstructions(manifest),
      targets: [`${manifest.specsDir}/`],
    });
  }
  if (!skillExists || (skillText !== null && /\bTODO\b/.test(skillText))) {
    guided.push({
      id: "sdd-skill",
      title: "Preencher a skill de domínio",
      instructions: skillInstructions(manifest),
      targets: [manifest.skillPath],
    });
  }

  // SDD já adotado, mas com o perímetro estreito ou regras sem spec: completar (a ação não se limita a adoções do zero)
  const universe = state.state === "ok" ? ruleUniverse(ctx) : null;
  if (state.state === "ok" && universe && (universe.citedOutsidePerimeter.length || universe.declaredUncited.length || universe.siblingsUncited.length)) {
    const requested = parseGlobs(params["rule_globs"]);
    const additions = params["perimeter"] === "none" ? [] : requested.length ? requested : suggestPerimeterGlobs(ctx, universe);
    const merged = [...new Set([...manifest.ruleCodeGlobs, ...additions])];
    if (merged.length > manifest.ruleCodeGlobs.length) {
      const raw = readForEdit(ctx, MANIFEST_PATH, notes);
      if (!raw.skip && raw.text !== null) {
        try {
          const json = JSON.parse(raw.text) as Record<string, unknown>;
          json["ruleCodeGlobs"] = merged;
          push(upsert(ctx, MANIFEST_PATH, JSON.stringify(json, null, 2) + "\n", { note: `perímetro ampliado: +${merged.length - manifest.ruleCodeGlobs.length} glob(s) para as pastas que as specs já citam` }));
        } catch {
          notes.push(`${MANIFEST_PATH}: JSON inválido; não alterei.`);
        }
      }
      notes.push(`Perímetro do SDD: ${universe.citedOutsidePerimeter.length} arquivo(s) citados pelas specs estão fora dos ruleCodeGlobs. Globs adicionados: ${additions.join(", ")}. Revise antes de mesclar; para outra lista, use --param rule_globs=a,b (ou perimeter=none).`);
    }
    const idx2 = getDocIndex(ctx);
    const skillLinks = (idx2.refs.get(manifest.skillPath) ?? []).map((r) => r.resolved).filter((r): r is string => !!r && /\.md$/i.test(r) && /(^|\/)skills\//.test(r));
    const missing = [...new Set([...universe.declaredUncited, ...universe.siblingsUncited])];
    if (missing.length) {
      guided.push({
        id: "sdd-gap-specs",
        title: `Cobrir com specs as regras sem documentação (${missing.length} arquivos)`,
        instructions: gapInstructions(manifest, universe, [manifest.skillPath, ...skillLinks]),
        targets: [`${manifest.specsDir}/`, manifest.skillPath, ...skillLinks, "repo-score.policy.json"],
      });
    }
  }

  const hooksPath = ctx.git(["config", "core.hooksPath"])?.trim() ?? "";
  if (hooksPath === "") postSteps.push("Ativar os hooks neste clone (não entra na branch): git config core.hooksPath .githooks");
  else if (hooksPath !== ".githooks") {
    notes.push(`core.hooksPath já aponta para "${hooksPath}" (outra ferramenta de hooks): não vou sobrescrevê-lo. Integre os hooks de .githooks/ à ferramenta existente.`);
  }
  // Repo que já adotou o SDD (manifest válido) e está completo: não há o que adotar. Só o texto da seção do README
  // poderia diferir do modelo atual, o que não justifica oferecer a ação (nem inflar a previsão de ganho).
  const alreadyAdopted = state.state === "ok" && guided.length === 0 && changes.every((c) => c.path === "README.md");
  if (alreadyAdopted || (changes.length === 0 && guided.length === 0)) return null;
  return { changes, guided, notes, postSteps };
}
