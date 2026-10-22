import { cpSync } from "node:fs";
import { join } from "node:path";

const id = process.env.CASE_ID;
const repo = process.env.REPO_DIR;
if (!id?.startsWith("scout-") || !repo) throw new Error("scout prepare requires CASE_ID and REPO_DIR");
// Only source fixtures enter the model's cwd. Tasks/references stay outside it.
cpSync(join(import.meta.dir, "fixtures", id.slice("scout-".length)), repo, { recursive: true, force: false, errorOnExist: true });
