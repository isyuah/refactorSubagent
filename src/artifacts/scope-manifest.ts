import { z } from "zod";
import { RelPath } from "./common.js";

/** A file the refactor agent is allowed to rewrite, plus target symbols inside it. */
const EditTarget = z.object({
  file: RelPath,
  symbols: z.array(z.string().min(1)).min(1),
});

/**
 * Scope Manifest — separation of Modification Scope vs Observation Scope.
 * editable ⊆ readable is enforced; forbidden wins over both.
 */
export const ScopeManifest = z
  .object({
    kind: z.literal("scope-manifest"),
    version: z.literal(1),

    editable_files: z.array(EditTarget).min(1),
    /** Globs the agent may read to understand behavior. Must include everything editable. */
    readable_globs: z.array(z.string().min(1)).min(1),
    /** Hard denials; checked before readable/editable. */
    forbidden_globs: z.array(z.string().min(1)).default([]),
  })
  .refine(
    (m) =>
      m.editable_files.every((t) => matchGlob(t.file, m.readable_globs)),
    { message: "every editable file must also be covered by readable_globs" },
  );

/** Minimal glob matcher supporting **, * and ? — sufficient for manifest checks. */
export function matchGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero segments
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export type ScopeManifest = z.infer<typeof ScopeManifest>;
