import { z } from "zod";

export const ToolProbe = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
});

/**
 * Host Preflight — facts measured by the program, never inferred by Claude.
 * Paths are absolute host paths and intentionally are not RelPath values.
 */
export const HostPreflight = z.object({
  kind: z.literal("host-preflight"),
  version: z.literal(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  shell: z.enum(["cmd.exe", "powershell.exe", "bash", "unknown"]),
  supports_posix_shell: z.boolean(),
  executable_suffix: z.string(),
  working_directory: z.string().min(1),
  tools: z.record(ToolProbe),
});

export type HostPreflight = z.infer<typeof HostPreflight>;
export type ToolProbe = z.infer<typeof ToolProbe>;
