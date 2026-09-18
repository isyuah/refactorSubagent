import { cloneSource, envDir } from "../../runner/case-api.js";

// libuv v1.52.1, shallow: the environment carries the source the task needs and
// none of the history (or judgement material) the candidate must not see.
cloneSource("libuv", { into: envDir() });
