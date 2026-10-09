import type { Collector } from "../collectors/context.js";
import { COLLECTORS as LEGACY_COLLECTORS } from "../collectors/index.js";
import { documentation } from "./documentation/index.js";
import type { GroupModule } from "./types.js";

/** Grupos com módulo próprio. Os demais ainda usam os coletores de src/collectors (serão migrados um a um). */
export const GROUP_MODULES: GroupModule[] = [documentation];

export const groupModule = (id: string): GroupModule | undefined => GROUP_MODULES.find((g) => g.id === id);

export const ALL_COLLECTORS: Collector[] = [...LEGACY_COLLECTORS, ...GROUP_MODULES.flatMap((g) => g.collectors)];
