/**
 * Sanitizer capability types — what the host measured it can build with.
 * (Result artifacts were part of the removed custom pipeline; verification
 * runs are owned by the generated workflows.)
 */
import { z } from "zod";

export const SanitizerKind = z.enum(["address", "undefined"]);
export type SanitizerKind = z.infer<typeof SanitizerKind>;

/** Measured compiler capability; availability is never inferred from a flag name. */
export const SanitizerCapability = z.object({
  available: z.boolean(),
  compiler: z.string().nullable(),
  flags: z.array(z.string()),
  reason: z.string().min(1),
});
export type SanitizerCapability = z.infer<typeof SanitizerCapability>;
