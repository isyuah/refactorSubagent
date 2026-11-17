/** Offline CLI preparation uses the production driver adapter and real host execution. */
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DriverOptions } from "../../src/agents/driver.js";
import { cliFixture } from "./cli-fixture.js";
import { preparationReplay } from "./test-preparation.js";

const parent = Bun.argv[2]; assert(parent);
mkdirSync(resolve(parent), { recursive: true });
const fixture = cliFixture("accept", resolve(parent));
const replay = preparationReplay();
mock.module("../../src/agents/driver.js", () => ({ runAgent: (o: DriverOptions) => {
  const server = o.mcpServers?.["dep-registry"]; assert(server?.type === "sdk");
  return replay.author({ ...o, agents: o.agents ?? {}, mcpServers: { "dep-registry": server }, allowedTools: o.allowedTools,
    extraAllowedTools: o.extraAllowedTools ?? [], skills: o.skills ?? [], maxTurns: o.maxTurns ?? null });
} }));
Bun.argv.splice(0, Bun.argv.length, process.execPath, "scripts/cli.ts", "tests", "prepare", fixture.repo, "--scope", "Protect function results", "--session-root", fixture.sessionRoot,
  "--session", "cli-preparation", "--ui", "plain", "--format", "json", "--no-color", "--no-interactive");
await import("../../scripts/cli.js");
