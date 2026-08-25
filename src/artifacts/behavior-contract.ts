import { z } from "zod";
import { B64, RelPath } from "./common.js";

/**
 * Behavior Contract — the structured definition of WHICH observable behavior
 * must be preserved and how strictly each channel is compared.
 */
export const CompareMode = z.enum([
  "exact", // byte-identical
  "semantic", // equal under a named comparator (order-insensitive FS effects, …)
  "normalize", // equal after canonicalization (timestamps, line endings)
  "ignore",
]);

export const ChannelPolicy = z.object({
  mode: CompareMode,
  /** Required when mode === 'semantic': comparator id, e.g. `fs-effects-v1`. */
  comparator: z.string().min(1).optional(),
});

export const BehaviorContract = z
  .object({
    kind: z.literal("behavior-contract"),
    version: z.literal(1),

    channels: z.object({
      exit_code: ChannelPolicy,
      signals: ChannelPolicy,
      stdout: ChannelPolicy,
      stderr: ChannelPolicy,
      filesystem: ChannelPolicy,
    }),

    allowed_change: z
      .object({
        internal_structure: z.boolean(),
        execution_time: z.boolean(),
      })
      .refine((a) => a.execution_time, {
        message: "execution_time must be allowed; timing is never preserved",
      }),

    notes: z.array(z.string()).default([]),
  })
  .refine(
    (c) =>
      Object.values(c.channels).every(
        (p) => p.mode !== "semantic" || p.comparator !== undefined,
      ),
    { message: "semantic channel policies require a comparator id" },
  );

export type BehaviorContract = z.infer<typeof BehaviorContract>;
