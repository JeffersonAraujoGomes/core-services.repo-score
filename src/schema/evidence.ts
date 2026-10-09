import { z } from "zod";
import { PROFILE_FLAGS } from "./rubric.js";

/**
 * Evidência de um achado. Princípio 1 da rubrica: todo critério emite
 * caminho:linha, URL do recurso ou nome do job. Pontuação sem evidência é inválida.
 */
export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    snippet: z.string().optional(),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    path: z.string().optional(),
    note: z.string().optional(),
  }),
  z.object({ kind: z.literal("url"), url: z.string().url(), note: z.string().optional() }),
  z.object({ kind: z.literal("job"), name: z.string().min(1), note: z.string().optional() }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CriterionResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.string(),
    status: z.literal("measured"),
    value: z.union([z.number(), z.string()]),
    evidence: z.array(EvidenceSchema),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  }),
  z.object({
    id: z.string(),
    status: z.literal("unmeasured"),
    reason: z.string().min(1),
  }),
  z.object({
    id: z.string(),
    status: z.literal("not_applicable"),
    reason: z.string().min(1),
  }),
]);
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const ProfileSchema = z.object(
  Object.fromEntries(PROFILE_FLAGS.map((f) => [f, z.boolean()])) as Record<
    (typeof PROFILE_FLAGS)[number],
    z.ZodBoolean
  >,
);
export type Profile = z.infer<typeof ProfileSchema>;

/** Entrada do scorer: o que os coletores e agentes produzem. */
export const ResultsFileSchema = z.object({
  repo: z.string().min(1),
  generated_at: z.string().optional(),
  rubric_version: z.string().optional(),
  profile: ProfileSchema,
  results: z.array(CriterionResultSchema),
});
export type ResultsFile = z.infer<typeof ResultsFileSchema>;
