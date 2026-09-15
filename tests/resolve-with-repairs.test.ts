import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithRepairs, type WorkflowRepairRequest } from "../src/workflow/resolve-with-repairs.js";
import { WorkflowPolicyError } from "../src/workflow/source-policy.js";

const VALID = `export const workflowKind = "test-workflow-driven";

export default async (ctx) => {
  const run = await ctx.process.run({ program: "true", args: [] });
  ctx.expect("exit", run.exitCode);
};
`;

/** A source the source policy rejects: a host global, not prose. */
const VIOLATING = `export const workflowKind = "test-workflow-driven";

export default async (ctx) => {
  const home = process.env.HOME;
  ctx.expect("home", home);
};
`;

function fixture(initial: string) {
  const root = mkdtempSync(join(tmpdir(), "rfr-repairs-"));
  const entry = join(root, "workflows", "test", "test-workflow.ts");
  mkdirSync(join(root, "workflows", "test"), { recursive: true });
  writeFileSync(entry, initial, "utf8");
  return { root, entry };
}

function resolveOptions(root: string, entry: string, repair: (request: WorkflowRepairRequest) => Promise<{ ok: boolean; timedOut: boolean; summary: string }>, policyRepairs: number) {
  return {
    workspaceRoot: root,
    entryRoot: root,
    testEntry: entry,
    testWorkflowId: "test-sess",
    testRevision: 1,
    builds: [],
    policyRepairs,
    repair,
  };
}

describe("resolveWithRepairs", () => {
  test("reports the violation, then resolves after the writer fixes the file", async () => {
    const { root, entry } = fixture(VIOLATING);
    const requests: WorkflowRepairRequest[] = [];
    const resolved = await resolveWithRepairs(
      resolveOptions(
        root,
        entry,
        async (request) => {
          requests.push(request);
          writeFileSync(entry, VALID, "utf8");
          return { ok: true, timedOut: false, summary: "replaced process.env with ctx.fs" };
        },
        1,
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.violation.rule).toBe("host-global");
    expect(requests[0]?.violation.detail).toBe("process.");
    expect(requests[0]?.violation.line).toBe(4);
    expect(requests[0]?.kind).toBe("test");
    expect(resolved.test.sourceHash).toBeString();
  });

  test("gives up after the allowed attempts when the source stays invalid", async () => {
    const { root, entry } = fixture(VIOLATING);
    let attempts = 0;
    const failing = resolveWithRepairs(
      resolveOptions(
        root,
        entry,
        async () => {
          attempts += 1;
          return { ok: true, timedOut: false, summary: "no change" };
        },
        2,
      ),
    );

    await expect(failing).rejects.toThrow(WorkflowPolicyError);
    expect(attempts).toBe(2);
  });

  test("never repairs when the budget is zero", async () => {
    const { root, entry } = fixture(VIOLATING);
    let attempts = 0;
    const failing = resolveWithRepairs(
      resolveOptions(
        root,
        entry,
        async () => {
          attempts += 1;
          return { ok: true, timedOut: false, summary: "no change" };
        },
        0,
      ),
    );

    await expect(failing).rejects.toThrow(WorkflowPolicyError);
    expect(attempts).toBe(0);
  });

  test("does not repair failures a rewrite cannot fix", async () => {
    const { root, entry } = fixture(VALID);
    rmSync(entry);
    let attempts = 0;
    const failing = resolveWithRepairs(
      resolveOptions(
        root,
        entry,
        async () => {
          attempts += 1;
          writeFileSync(entry, VALID, "utf8");
          return { ok: true, timedOut: false, summary: "recreated" };
        },
        2,
      ),
    );

    await expect(failing).rejects.toThrow(/does not exist/);
    expect(attempts).toBe(0);
  });
});
