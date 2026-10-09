// Templates copiados do core-services.sdd-gate-ia por `npm run sync-sdd-templates` (não edite os arquivos).
import discoveryPrompt from "./templates/discovery-prompt.md";
import postCommit from "./templates/post-commit.sh";
import preCommit from "./templates/pre-commit.sh";
import prePush from "./templates/pre-push.sh";
import readmeSection from "./templates/readme-section.md";
import sddAnalyze from "./templates/sdd-analyze.sh";
import skillTemplate from "./templates/skill-template.md";
import specChangeGuard from "./templates/spec-change-guard.sh";

export const TEMPLATES = { discoveryPrompt, postCommit, preCommit, prePush, readmeSection, sddAnalyze, skillTemplate, specChangeGuard };

/** Arquivos copiados verbatim para o repo alvo (leem .sdd/manifest.json em runtime, via jq). */
export const HOOK_FILES: { path: string; content: string }[] = [
  { path: ".githooks/pre-commit", content: preCommit },
  { path: ".githooks/sdd-analyze", content: sddAnalyze },
  { path: ".githooks/post-commit", content: postCommit },
  { path: ".githooks/pre-push", content: prePush },
  { path: ".claude/hooks/spec-change-guard.sh", content: specChangeGuard },
];
