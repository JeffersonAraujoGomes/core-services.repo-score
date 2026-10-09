import path from "node:path";
import type { Evidence } from "../schema/evidence.js";
import { capEvidence, jobEvidence, measured, type Collector, type Ctx } from "./context.js";

type Kind = "json" | "yaml" | "env";

/** Arquivos onde um segredo literal conta como S1 (rubrica 5.1 e 5.8: config e IaC, não só appsettings). */
export function configKind(rel: string): Kind | null {
  const lower = rel.toLowerCase();
  const base = path.posix.basename(lower);
  if (/\.(example|sample|template|dist)$/.test(base)) return null;
  if (/^appsettings.*\.json$/.test(base)) return "json";
  if (/^\.env(\..+)?$/.test(base) || base.endsWith(".env")) return "env";
  if (/^application.*\.properties$/.test(base)) return "env";
  if (/^application.*\.ya?ml$/.test(base)) return "yaml";
  if (/^values.*\.ya?ml$/.test(base)) return "yaml";
  if (/^(docker-)?compose.*\.ya?ml$/.test(base)) return "yaml";
  if (/\.ya?ml$/.test(base) && /(^|\/)(k8s|kubernetes|helm|charts?|iac|deploy|deployment|manifests?|argocd|infra)(\/|$)/.test(lower)) {
    return "yaml";
  }
  return null;
}

const SENSITIVE_KEY = /(passw(or)?d|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|connection[_-]?string)/i;
// Chaves que apontam para um segredo ou descrevem sua configuração, sem conter o valor.
const NON_VALUE_SUFFIX =
  /(name|ref|file|path|arn|url|uri|endpoint|expir\w*|ttl|length|policy|version|type|enabled|required|mode|provider|store|class|header|prefix|claim|scope|audience|issuer|algorithm|format|id|dir|directory|folder|mount|location)$/i;

const PLACEHOLDER = /^(|null|~|none|true|false|\[\]|\{\}|\||>|\|-|>-|\|\+|>\+)$/i;

/** O valor é uma referência/template (cofre, env, helm), não um literal. */
function isReference(v: string): boolean {
  return (
    PLACEHOLDER.test(v) ||
    /\$\{|\{\{|\$\(|^\$|^%|^<.*>$|^@Microsoft\.KeyVault|^vault:|^ref\+|^arn:|^secret:\/\/|^env:|^ssm:/i.test(v)
  );
}

function stripValue(raw: string): string {
  const v = raw.trim();
  const quoted = /^(["'])(.*?)\1/.exec(v);
  if (quoted) return quoted[2] ?? "";
  return v.replace(/\s+#.*$/, "").replace(/,$/, "").trim();
}

/** Senha embutida em connection string (`Password=abc;`) ou URL (`scheme://user:pass@host`). */
function embeddedPassword(value: string): boolean {
  const kv = /(?:password|pwd)\s*=\s*([^;]*)/i.exec(value);
  if (kv && kv[1] !== undefined && !isReference(kv[1].trim().replace(/^["']|["']$/g, ""))) return true;
  const url = /:\/\/[^/\s:@]+:([^@\s/]+)@/.exec(value);
  return !!url && !isReference(url[1] ?? "");
}

interface Pair {
  key: string;
  value: string;
}

function pairsOf(line: string, kind: Kind): Pair[] {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return [];
  if (kind === "json") {
    const out: Pair[] = [];
    for (const m of line.matchAll(/"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      out.push({ key: m[1] ?? "", value: m[2] ?? "" });
    }
    return out;
  }
  const m = /^\s*(?:-\s+)?["']?([A-Za-z_][\w.\-[\]]*)["']?\s*[:=]\s*(.*?)\s*$/.exec(line);
  return m ? [{ key: m[1] ?? "", value: stripValue(m[2] ?? "") }] : [];
}

// `existingSecret: nome`, `useSecret: true`: chaves que escolhem ou ligam um segredo, sem conter o valor.
const NON_VALUE_PREFIX = /^(existing|use|enable|disable|create|mount)/i;

function sensitiveLiteral(p: Pair): boolean {
  if (embeddedPassword(p.value)) return true;
  if (isReference(p.value)) return false;
  const leaf = p.key.split(".").pop() ?? p.key;
  return SENSITIVE_KEY.test(leaf) && !NON_VALUE_SUFFIX.test(leaf) && !NON_VALUE_PREFIX.test(leaf);
}

// Documentos que, por definição, não carregam segredo em claro (referência a cofre ou valor cifrado).
const SAFE_KIND = /^kind:\s*(ExternalSecret|ClusterExternalSecret|SecretStore|ClusterSecretStore|SealedSecret|PushSecret)\s*$/;

/** Intervalos de linhas (1-based, inclusivos) de documentos YAML seguros. */
function safeDocRanges(lines: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  const close = (end: number) => {
    if (lines.slice(start, end).some((l) => SAFE_KIND.test(l))) ranges.push([start + 1, end]);
  };
  lines.forEach((l, i) => {
    if (/^---\s*$/.test(l)) {
      close(i);
      start = i + 1;
    }
  });
  close(lines.length);
  return ranges;
}

interface Finding {
  line: number;
  key: string;
}

function scanSecretManifest(text: string): Finding[] {
  // Documento `kind: Secret` com valores literais em data/stringData (SealedSecret e ExternalSecret têm outro kind).
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  let start = 0;
  const flush = (end: number) => {
    const doc = lines.slice(start, end);
    if (!doc.some((l) => /^kind:\s*Secret\s*$/.test(l))) return;
    let inData = false;
    doc.forEach((l, i) => {
      if (/^(data|stringData):\s*$/.test(l)) {
        inData = true;
        return;
      }
      if (inData && /^\S/.test(l) && l.trim() !== "") inData = false;
      if (!inData) return;
      const m = /^\s+["']?([\w.\-]+)["']?\s*:\s*(.*?)\s*$/.exec(l);
      if (m && !isReference(stripValue(m[2] ?? ""))) out.push({ line: start + i + 1, key: m[1] ?? "" });
    });
  };
  lines.forEach((l, i) => {
    if (/^---\s*$/.test(l)) {
      flush(i);
      start = i + 1;
    }
  });
  flush(lines.length);
  return out;
}

export function scanConfigText(text: string, kind: Kind): Finding[] {
  const found = new Map<number, Finding>();
  const lines = text.split(/\r?\n/);
  const safe = kind === "yaml" ? safeDocRanges(lines) : [];
  let pendingName: string | null = null;
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (safe.some(([a, b]) => n >= a && n <= b)) return;
    for (const p of pairsOf(line, kind)) {
      // `- name: DB_PASSWORD` seguido de `value: literal` (env de container em K8s/compose)
      if (kind === "yaml" && p.key === "name") {
        pendingName = SENSITIVE_KEY.test(p.value) && !NON_VALUE_SUFFIX.test(p.value) ? p.value : null;
        continue;
      }
      if (kind === "yaml" && p.key === "value" && pendingName) {
        if (!isReference(p.value)) found.set(n, { line: n, key: "value" });
        pendingName = null;
        continue;
      }
      if (sensitiveLiteral(p)) found.set(n, { line: n, key: p.key });
    }
  });
  if (kind === "yaml") {
    for (const f of scanSecretManifest(text)) if (!found.has(f.line)) found.set(f.line, f);
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function allowlisted(ctx: Ctx, rel: string): boolean {
  return ctx.policy.secret_allowlist.some((a) => rel === a.path || rel.startsWith(a.path.replace(/\/?$/, "/")));
}

export const s1ConfigSecrets: Collector = {
  ids: ["S1"],
  async run(ctx) {
    const evidence: Evidence[] = [];
    let scanned = 0;
    let skipped = 0;
    let count = 0;
    for (const rel of ctx.files) {
      const kind = configKind(rel);
      if (!kind) continue;
      if (allowlisted(ctx, rel)) {
        skipped += 1;
        continue;
      }
      const text = ctx.readText(rel);
      if (text === null) continue;
      scanned += 1;
      for (const f of scanConfigText(text, kind)) {
        count += 1;
        // O snippet é só a chave: o relatório nunca reproduz o valor do segredo.
        evidence.push({ kind: "file", path: rel, line: f.line, snippet: f.key, note: "valor literal em config/IaC" });
      }
    }
    if (count === 0) {
      return [
        measured("S1", 0, [
          jobEvidence(
            "s1-config-secrets",
            `${scanned} arquivos de config/IaC verificados, nenhum segredo literal${skipped ? `; ${skipped} em allowlist` : ""}`,
          ),
        ]),
      ];
    }
    return [measured("S1", count, capEvidence(evidence))];
  },
};
