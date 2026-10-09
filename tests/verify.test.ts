import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CriterionResult, Evidence } from "../src/schema/evidence.js";
import { verifyEvidence, verifyResults } from "../src/verify/verify-evidence.js";

let root: string;
let outside: string;
let sha: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "rs-verify-"));
  outside = mkdtempSync(path.join(tmpdir(), "rs-outside-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src", "db.cs"),
    ["using System;", "var q = $\"SELECT * FROM t WHERE id = {id}\";", "var r = await conn.QueryAsync<T>(", "    q);"].join("\n"),
  );
  writeFileSync(path.join(outside, "secret.txt"), "top secret");
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  sha = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const file = (p: string, line?: number, snippet?: string) => ({ kind: "file" as const, path: p, line, snippet });

describe("verifyEvidence", () => {
  it("aceita arquivo, linha e trecho que existem (ignorando espaços)", () => {
    expect(verifyEvidence(root, file("src/db.cs"))).toEqual({ ok: true, verified: true });
    expect(verifyEvidence(root, file("src/db.cs", 2))).toEqual({ ok: true, verified: true });
    expect(verifyEvidence(root, file("src/db.cs", 2, 'var   q = $"SELECT * FROM t'))).toEqual({
      ok: true,
      verified: true,
    });
  });

  it("aceita trecho de várias linhas começando na linha indicada", () => {
    expect(verifyEvidence(root, file("src/db.cs", 3, "var r = await conn.QueryAsync<T>(\n q);")).ok).toBe(true);
  });

  it("aceita trecho sem linha se existir em qualquer ponto do arquivo", () => {
    expect(verifyEvidence(root, file("src/db.cs", undefined, "using System;")).ok).toBe(true);
    expect(verifyEvidence(root, file("src/db.cs", undefined, "nada disso existe")).ok).toBe(false);
  });

  it("rejeita arquivo inexistente, linha fora do arquivo e trecho que não bate", () => {
    expect(verifyEvidence(root, file("src/nao.cs"))).toMatchObject({ ok: false, reason: "arquivo não existe" });
    expect(verifyEvidence(root, file("src/db.cs", 99))).toMatchObject({ ok: false });
    expect(verifyEvidence(root, file("src/db.cs", 1, "SELECT"))).toMatchObject({
      ok: false,
      reason: "o trecho não está na linha 1",
    });
    expect(verifyEvidence(root, file("src/db.cs", 1, "   "))).toMatchObject({ ok: false, reason: "trecho vazio" });
  });

  it("rejeita diretório, caminho absoluto, '..' e symlink que escapa da raiz", () => {
    expect(verifyEvidence(root, file("src"))).toMatchObject({ ok: false });
    expect(verifyEvidence(root, file(path.join(outside, "secret.txt")))).toMatchObject({ ok: false });
    expect(verifyEvidence(root, file("../" + path.basename(outside) + "/secret.txt"))).toMatchObject({
      ok: false,
      reason: "caminho fora da raiz do repo",
    });
    expect(verifyEvidence(root, file("link.txt"))).toMatchObject({
      ok: false,
      reason: "symlink aponta para fora da raiz do repo",
    });
  });

  it("confere commit no git; url e job não são verificáveis localmente", () => {
    expect(verifyEvidence(root, { kind: "commit", sha })).toEqual({ ok: true, verified: true });
    expect(verifyEvidence(root, { kind: "commit", sha: "deadbeefdeadbeef" })).toMatchObject({ ok: false });
    expect(verifyEvidence(root, { kind: "job", name: "build" })).toEqual({ ok: true, verified: false });
    expect(verifyEvidence(root, { kind: "url", url: "https://github.com/x/y" })).toEqual({ ok: true, verified: false });
  });
});

describe("verifyResults", () => {
  const measured = (id: string, evidence: Evidence[]): CriterionResult => ({
    id,
    status: "measured",
    value: 1,
    evidence,
  });

  it("descarta evidência inválida; sem nenhuma válida o critério vira unmeasured", () => {
    const { results, issues } = verifyResults(root, [
      measured("S3", [file("src/db.cs", 99)]),
      measured("S1", [file("src/db.cs", 2), file("src/inventada.cs", 1)]),
      measured("S2", [file("src/db.cs", 2)]),
    ]);
    expect(results[0]).toMatchObject({ id: "S3", status: "unmeasured" });
    expect((results[0] as { reason: string }).reason).toMatch(/^evidência inválida/);
    expect(results[1]).toMatchObject({ id: "S1", status: "measured", confidence: "low" });
    expect((results[1] as { evidence: unknown[] }).evidence).toHaveLength(1);
    expect(results[2]).toMatchObject({ id: "S2", status: "measured" });
    expect(issues.map((i) => i.id)).toEqual(["S3", "S1"]);
  });

  it("não mexe em unmeasured, N/A nem em resultado sem evidência (V20 é do scorer)", () => {
    const input: CriterionResult[] = [
      { id: "O1", status: "unmeasured", reason: "x" },
      { id: "S6", status: "not_applicable", reason: "x" },
      measured("T2", []),
    ];
    expect(verifyResults(root, input).results).toEqual(input);
  });
});
