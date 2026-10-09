/**
 * Merges seguros em arquivos que provavelmente já existem no repo alvo (port de sdd_bootstrap/merge.py).
 * Nunca sobrescrevem o resto do conteúdo: só adicionam ou atualizam a parte do SDD.
 */
export const HOOK_COMMAND = '"$CLAUDE_PROJECT_DIR/.claude/hooks/spec-change-guard.sh"';
export const README_START = "<!-- sdd-bootstrap:readme-section -->";
export const README_END = "<!-- /sdd-bootstrap:readme-section -->";

export interface MergeResult {
  content: string;
  changed: boolean;
  note: string;
}

export function mergeClaudeSettings(existing: string | null): MergeResult {
  let data: { hooks?: { PostToolUse?: { matcher?: string; hooks?: { type?: string; command?: string }[] }[] } } = {};
  if (existing !== null) {
    try {
      data = JSON.parse(existing);
    } catch {
      return { content: existing, changed: false, note: ".claude/settings.json existente não é JSON válido: não alterei (ajuste manual necessário)" };
    }
  }
  const hooks = (data.hooks ??= {});
  const post = (hooks.PostToolUse ??= []);
  if (post.some((e) => e.hooks?.some((h) => h.command === HOOK_COMMAND))) {
    return { content: existing ?? "", changed: false, note: "hook PostToolUse já configurado" };
  }
  const matcher = "Edit|Write|MultiEdit";
  let entry = post.find((e) => e.matcher === matcher);
  if (!entry) {
    entry = { matcher, hooks: [] };
    post.push(entry);
  }
  (entry.hooks ??= []).push({ type: "command", command: HOOK_COMMAND });
  return { content: JSON.stringify(data, null, 2) + "\n", changed: true, note: "hook PostToolUse adicionado em .claude/settings.json" };
}

export function mergeGitignore(existing: string | null, specsDir: string): MergeResult {
  const base = specsDir.replace(/\/+$/, "");
  const line = `${base}/.impact-reports/`;
  const text = existing ?? "";
  if (text.includes(line) || text.includes(`${base}/.impact-reports`)) {
    return { content: text, changed: false, note: ".gitignore já cobre a pasta de relatórios de impacto" };
  }
  const sep = text !== "" && !text.endsWith("\n") ? "\n" : "";
  return {
    content: `${text}${sep}\n# sdd-bootstrap: relatórios de impacto gerados (efêmero, não versionar)\n${line}\n`,
    changed: true,
    note: `.gitignore: ${line}`,
  };
}

export function mergeReadmeSection(existing: string | null, section: string, title: string): MergeResult {
  const content = existing ?? `# ${title}\n`;
  const re = new RegExp(`${README_START}[\\s\\S]*?${README_END}`);
  const rendered = section.trim();
  if (re.test(content)) {
    const next = content.replace(re, () => rendered);
    return next === content
      ? { content, changed: false, note: "README.md já tem a seção SDD (idêntica)" }
      : { content: next, changed: true, note: "README.md: seção SDD atualizada" };
  }
  const sep = content.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${content}${sep}${rendered}\n`, changed: true, note: "README.md: seção SDD adicionada" };
}
