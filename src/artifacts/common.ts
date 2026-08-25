import { z } from "zod";

/** Relative POSIX-style path inside the target repo. */
export const RelPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p), {
    message: "paths must be repo-relative",
  });

/** base64-encoded payload (stdin bytes, fixture contents, captured output). */
export const B64 = z.string();

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
