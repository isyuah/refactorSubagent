import type { HostPreflight, ProjectDetection } from "../artifacts/index.js";

/** Measured authoring context shared by the test-writer and build-writer. */
export function workflowPreflightContext(host: HostPreflight, project: ProjectDetection): string {
  return [
    "Host-measured preflight facts (not a prescribed verification strategy):",
    JSON.stringify(host, null, 2),
    `Detected project (showing up to 80 of ${project.source_files.length} source files; inspect relevant files yourself):`,
    JSON.stringify({ ...project, source_files: project.source_files.slice(0, 80) }, null, 2),
    "Preflight discovers tools and project build markers and queries CMake metadata; it does not configure or build a project. " +
      "Tool availability means a path was found, and listed generators are CMake capabilities. " +
      "Project status describes discovery only, including legacy statuses in saved artifacts. " +
      "Choose verification scope from source and existing coverage; build-writer confirms the selected build against the real sources.",
    "At execution use ctx.facts and worktree-relative paths. Never embed the authoring repo_root, working_directory or scratch paths.",
  ].join("\n");
}
