import { z } from "zod";
import { SanitizerCapability } from "./sanitizer.js";

export const ToolProbe = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
});

export const CMakePreflight = z.object({
  version: z.string().nullable().default(null),
  generators: z.array(z.string()).default([]),
  default_generator: z.string().nullable().default(null),
  c_compiler: z.string().nullable().default(null),
  configure_probe: z.enum(["pass", "fail", "not-run"]).default("not-run"),
  build_probe: z.enum(["pass", "fail", "not-run"]).default("not-run"),
  reason: z.string().nullable().default(null),
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
  cmake: CMakePreflight.default({}),
  sanitizers: z.record(SanitizerCapability).default({}),
});

export type HostPreflight = z.infer<typeof HostPreflight>;
export type ToolProbe = z.infer<typeof ToolProbe>;
export type CMakePreflight = z.infer<typeof CMakePreflight>;
