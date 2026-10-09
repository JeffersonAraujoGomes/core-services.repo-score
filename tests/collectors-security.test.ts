import { afterAll, describe, expect, it } from "vitest";
import { s12Lockfile } from "../src/collectors/s12-lockfile.js";
import { s13ActionsPinning } from "../src/collectors/s13-actions-pinning.js";
import { s1ConfigSecrets } from "../src/collectors/s1-config-secrets.js";
import { s2HistorySecrets } from "../src/collectors/s2-history-secrets.js";
import { s9BaseImage } from "../src/collectors/s9-base-image.js";
import { cleanupFixtures, evidenceOf, makeRepo, run1, valueOf } from "./fixture-repo.js";

afterAll(cleanupFixtures);

// Segredos de teste montados em runtime para não acionar scanners no próprio arquivo de teste.
const fakeAwsKey = () => "AKIA" + "QWERTYUIOP123456";
const literal = () => ["s3", "cr3t", "Value9"].join("");

describe("S1 · segredos em config/IaC", () => {
  it("V17: Password \"guest\" em appsettings conta como achado", async () => {
    const r = makeRepo();
    r.write("App/appsettings.json", `{\n  "Db": {\n    "Password": "guest"\n  }\n}\n`);
    const res = await run1(s1ConfigSecrets, r.ctx());
    expect(valueOf(res)).toBe(1);
    expect(evidenceOf(res)[0]).toMatchObject({ kind: "file", path: "App/appsettings.json", line: 3, snippet: "Password" });
  });

  it("V40: literal em values.yaml conta; a evidência nunca reproduz o valor", async () => {
    const r = makeRepo();
    const secret = literal();
    r.write("iac/values.yaml", `env:\n  DB_PASSWORD: ${secret}\n  LOG_LEVEL: info\n`);
    const res = await run1(s1ConfigSecrets, r.ctx());
    expect(valueOf(res)).toBe(1);
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it("V41: referências a cofre não contam (secretKeyRef, ExternalSecret, ${VAR}, helm)", async () => {
    const r = makeRepo();
    r.write(
      "iac/values.yaml",
      [
        "env:",
        "  - name: DB_PASSWORD",
        "    valueFrom:",
        "      secretKeyRef:",
        "        name: db",
        "        key: password",
        "  API_TOKEN: ${API_TOKEN}",
        "  OTHER: '{{ .Values.token }}'",
        "  secretName: my-secret",
        "  existingSecret: db-credentials",
        "  VAULT_SECRETS_FILE_DIR: /vault/secrets",
      ].join("\n"),
    );
    r.write("iac/ext.yaml", "apiVersion: external-secrets.io/v1\nkind: ExternalSecret\nspec:\n  data:\n    - secretKey: password\n      remoteRef:\n        key: prod/db\n");
    const res = await run1(s1ConfigSecrets, r.ctx());
    expect(valueOf(res)).toBe(0);
  });

  it("env de container: `- name: X_PASSWORD` + `value: literal` conta", async () => {
    const r = makeRepo();
    r.write("k8s/deploy.yaml", `env:\n  - name: DB_PASSWORD\n    value: ${literal()}\n  - name: REGION\n    value: us-east-1\n`);
    const res = await run1(s1ConfigSecrets, r.ctx());
    expect(valueOf(res)).toBe(1);
    expect(evidenceOf(res)[0]).toMatchObject({ line: 3 });
  });

  it("kind: Secret com literal conta; SealedSecret não", async () => {
    const r = makeRepo();
    r.write("deploy/secret.yaml", `apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  anything: ${literal()}\n`);
    r.write("deploy/sealed.yaml", `kind: SealedSecret\nspec:\n  encryptedData:\n    password: AgBy8hCi...\n`);
    const res = await run1(s1ConfigSecrets, r.ctx());
    expect(valueOf(res)).toBe(1);
    expect(evidenceOf(res)[0]).toMatchObject({ path: "deploy/secret.yaml", line: 6 });
  });

  it("connection string: senha literal conta; senha por variável não", async () => {
    const r = makeRepo();
    r.write("a/appsettings.json", `{ "ConnectionStrings": { "Default": "Server=db;User=u;Password=${literal()};" } }\n`);
    r.write("b/appsettings.json", `{ "ConnectionStrings": { "Default": "Server=db;User=u;Password=\${DB_PASS};" } }\n`);
    r.write("c/appsettings.json", `{ "Url": "postgres://user:${literal()}@host/db" }\n`);
    const res = await run1(s1ConfigSecrets, r.ctx());
    expect(evidenceOf(res).map((e) => (e.kind === "file" ? e.path : ""))).toEqual(["a/appsettings.json", "c/appsettings.json"]);
  });

  it("valores vazios, exemplos (.env.example) e allowlist com justificativa são ignorados", async () => {
    const r = makeRepo();
    r.write("appsettings.json", `{ "AccessKey": "", "SecretKey": null, "TokenEndpoint": "https://idp/token" }\n`);
    r.write(".env.example", "DB_PASSWORD=changeme\n");
    r.write("legacy/appsettings.json", `{ "Password": "${literal()}" }\n`);
    const ctx = r.ctx({ secret_allowlist: [{ path: "legacy", justification: "fixture de teste, sem acesso real" }] });
    const res = await run1(s1ConfigSecrets, ctx);
    expect(valueOf(res)).toBe(0);
  });

  it("allowlist sem justificativa é rejeitada pela política", () => {
    const r = makeRepo();
    expect(() => r.ctx({ secret_allowlist: [{ path: "x", justification: "ok" }] })).toThrow();
  });
});

describe("S2 · segredos no histórico", () => {
  it("encontra credencial de alta confiança removida depois e conta valores únicos", async () => {
    const r = makeRepo();
    const key = fakeAwsKey();
    r.write("config.txt", `key=${key}\n`);
    r.commit("add config");
    r.write("config.txt", "key=\n");
    r.commit("remove");
    r.write("copy.txt", `again=${key}\n`);
    r.commit("again");
    const res = await run1(s2HistorySecrets, r.ctx());
    expect(valueOf(res)).toBe(1); // o mesmo valor em dois commits conta uma vez
    expect(evidenceOf(res)[0]).toMatchObject({ kind: "commit", note: "chave de acesso AWS", path: "config.txt" });
    expect(JSON.stringify(res)).not.toContain(key);
  });

  it("chave de exemplo da documentação AWS não conta; histórico limpo mede 0", async () => {
    const r = makeRepo();
    r.write("doc.md", "AKIAIOSFODNN7EXAMPLE\n");
    r.commit("docs");
    const res = await run1(s2HistorySecrets, r.ctx());
    expect(valueOf(res)).toBe(0);
    expect(evidenceOf(res)[0]).toMatchObject({ kind: "job" });
  });

  it("fora de um repo git não mede", async () => {
    const r = makeRepo({ git: false });
    r.write("a.txt", "x");
    expect((await run1(s2HistorySecrets, r.ctx())).status).toBe("unmeasured");
  });
});

describe("S9 · imagem base", () => {
  it("acusa sem tag, :latest e registry não aprovado; aceita tag, digest, stage e scratch", async () => {
    const r = makeRepo();
    r.write(
      "Dockerfile",
      [
        "ARG BASE=mcr.microsoft.com/dotnet/aspnet:8.0",
        "FROM ${BASE} AS base",
        "FROM node AS a",
        "FROM node:latest AS b",
        "FROM node:20-alpine@sha256:abc AS c",
        "FROM base AS final",
        "FROM scratch",
        "from alpine:3.19",
      ].join("\n"),
    );
    const res = await run1(s9BaseImage, r.ctx());
    expect(valueOf(res)).toBe(2);
    expect(evidenceOf(res).map((e) => (e.kind === "file" ? e.line : 0))).toEqual([3, 4]);
  });

  it("registry fora da lista aprovada conta", async () => {
    const r = makeRepo();
    r.write("Dockerfile", "FROM evil.example.com/team/app:1.0\nFROM mcr.microsoft.com/dotnet/sdk:8.0\n");
    const res = await run1(s9BaseImage, r.ctx({ approved_registries: ["mcr.microsoft.com"] }));
    expect(valueOf(res)).toBe(1);
  });

  it("sem Dockerfile é N/A", async () => {
    const r = makeRepo();
    r.write("a.txt", "x");
    expect((await run1(s9BaseImage, r.ctx())).status).toBe("not_applicable");
  });
});

describe("S12 · lockfile", () => {
  it("npm: sem lock = absent; com lock = present; com `npm ci` no CI = locked", async () => {
    const r = makeRepo();
    r.write("package.json", "{}");
    expect(valueOf(await run1(s12Lockfile, r.ctx()))).toBe("absent");
    r.write("package-lock.json", "{}");
    expect(valueOf(await run1(s12Lockfile, r.ctx()))).toBe("present");
    r.write(".github/workflows/ci.yml", "jobs:\n  b:\n    steps:\n      - run: npm ci\n");
    expect(valueOf(await run1(s12Lockfile, r.ctx()))).toBe("locked");
  });

  it("monorepo: lock na raiz cobre pacotes; o pior ecossistema vence", async () => {
    const r = makeRepo();
    r.write("package.json", "{}");
    r.write("pkg/a/package.json", "{}");
    r.write("yarn.lock", "");
    r.write("svc/Svc.csproj", "<Project/>");
    const res = await run1(s12Lockfile, r.ctx());
    expect(valueOf(res)).toBe("absent"); // .NET sem packages.lock.json
    expect(evidenceOf(res).some((e) => e.kind === "file" && e.path === "svc/Svc.csproj")).toBe(true);
  });

  it("V47: Go com go.sum presente (sem verificação no CI) vale present", async () => {
    const r = makeRepo();
    r.write("go.mod", "module x");
    r.write("go.sum", "");
    expect(valueOf(await run1(s12Lockfile, r.ctx()))).toBe("present");
  });

  it("sem manifesto conhecido é N/A", async () => {
    const r = makeRepo();
    r.write("README.md", "x");
    expect((await run1(s12Lockfile, r.ctx())).status).toBe("not_applicable");
  });
});

describe("S13 · actions fixadas por SHA", () => {
  const sha = "a".repeat(40);

  it("V48: tag conta como não fixada; SHA, local e org confiável não", async () => {
    const r = makeRepo();
    r.write(
      ".github/workflows/ci.yml",
      [
        "jobs:",
        "  b:",
        "    steps:",
        "      - uses: actions/checkout@v4",
        `      - uses: actions/setup-node@${sha}`,
        "      - uses: ./.github/actions/local",
        "      - uses: neon/x@v1",
        "      - uses: docker://alpine:3",
      ].join("\n"),
    );
    const res = await run1(s13ActionsPinning, r.ctx({ trusted_action_orgs: ["neon"] }));
    expect(valueOf(res)).toBeCloseTo(66.7, 1); // 2 de 3 externas ok
    expect(evidenceOf(res)).toHaveLength(1);
    expect(evidenceOf(res)[0]).toMatchObject({ path: ".github/workflows/ci.yml", line: 4, snippet: "actions/checkout@v4" });
  });

  it("workflow com `uses:` de reusable workflow por tag conta", async () => {
    const r = makeRepo();
    r.write(".github/workflows/d.yaml", "jobs:\n  d:\n    uses: org/repo/.github/workflows/b.yaml@v1.0.0\n");
    expect(valueOf(await run1(s13ActionsPinning, r.ctx()))).toBe(0);
  });

  it("sem workflows é N/A", async () => {
    const r = makeRepo();
    r.write("a.txt", "x");
    expect((await run1(s13ActionsPinning, r.ctx())).status).toBe("not_applicable");
  });
});
