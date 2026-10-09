import { spawnSync } from "node:child_process";

/** O comando existe e responde (ex.: `git --version`)? */
export function hasCommand(cmd: string, args: string[] = ["--version"]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
