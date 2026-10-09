import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCtx, type Collector, type Ctx } from "../src/collectors/context.js";
import { PolicySchema, type Policy } from "../src/policy.js";
import type { CriterionResult } from "../src/schema/evidence.js";

const created: string[] = [];

export function cleanupFixtures(): void {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
}

export interface FixtureRepo {
  root: string;
  write(rel: string, content: string): void;
  git(...args: string[]): string;
  commit(message: string, date?: string): void;
  ctx(policy?: Partial<Policy>, now?: Date): Ctx;
}

export function makeRepo(opts: { git?: boolean } = {}): FixtureRepo {
  const root = mkdtempSync(path.join(tmpdir(), "rs-fixture-"));
  created.push(root);
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  if (opts.git !== false) {
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "t@t.local"]);
    run(["config", "user.name", "t"]);
    run(["config", "commit.gpgsign", "false"]);
  }
  return {
    root,
    write(rel, content) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    git: (...args) => run(args),
    commit(message, date) {
      run(["add", "-A"]);
      const env: Record<string, string> = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
      run(["commit", "-q", "--allow-empty", "-m", message], env);
    },
    ctx(policy = {}, now) {
      return createCtx(root, PolicySchema.parse(policy), now);
    },
  };
}

export async function run1(collector: Collector, ctx: Ctx, id?: string): Promise<CriterionResult> {
  const results = await collector.run(ctx);
  const r = results.find((x) => x.id === (id ?? collector.ids[0]));
  if (!r) throw new Error("coletor não produziu resultado");
  return r;
}

export function valueOf(r: CriterionResult): number | string {
  if (r.status !== "measured") throw new Error(`esperava measured, veio ${r.status}`);
  return r.value;
}

export function evidenceOf(r: CriterionResult) {
  if (r.status !== "measured") throw new Error(`esperava measured, veio ${r.status}`);
  return r.evidence;
}
