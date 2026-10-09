import { c12FileSize } from "./c12-file-size.js";
import type { Collector } from "./context.js";
import { p4Commits, p5CentralVersioning, p6Codeowners } from "./p-process.js";
import { s12Lockfile } from "./s12-lockfile.js";
import { s13ActionsPinning } from "./s13-actions-pinning.js";
import { s1ConfigSecrets } from "./s1-config-secrets.js";
import { s2HistorySecrets } from "./s2-history-secrets.js";
import { s9BaseImage } from "./s9-base-image.js";

/** Coletores determinísticos dos grupos que ainda não têm módulo próprio (src/groups). Nenhum gasta token. */
export const COLLECTORS: Collector[] = [
  s1ConfigSecrets,
  s2HistorySecrets,
  s9BaseImage,
  s12Lockfile,
  s13ActionsPinning,
  c12FileSize,
  p4Commits,
  p5CentralVersioning,
  p6Codeowners,
];
