import type {
  BehaviorContract,
  ComparisonResultInput,
  ObservationTrace,
  FsEffect,
} from "../artifacts/index.js";

/**
 * Comparator — applies the Behavior Contract's per-channel policy to align
 * baseline/candidate observations. Emits ComparisonResult INPUT; `overall`
 * is derived by the schema transform.
 */

type Channel = keyof BehaviorContract["channels"];
type Verdict = "match" | "mismatch" | "not_compared";

function compareBytes(
  mode: string,
  a: string,
  b: string,
): Verdict {
  if (mode === "ignore") return "not_compared";
  if (a === b) return "match";
  if (mode === "normalize") {
    return canonicalText(a) === canonicalText(b) ? "match" : "mismatch";
  }
  return "mismatch"; // exact
}

/** Canonicalize text: UTF-8, CRLF→LF, drop trailing whitespace per line. */
function canonicalText(b64: string): string {
  const text = Buffer.from(b64, "base64").toString("utf8");
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trimEnd())
    .join("\n");
}

function compareFilesystem(
  policy: { mode: string; comparator?: string },
  a: FsEffect[],
  b: FsEffect[],
): Verdict {
  if (policy.mode === "ignore") return "not_compared";
  if (policy.mode === "semantic") {
    if (policy.comparator !== "fs-effects-v1") return "mismatch";
    // fs-effects-v1: multiset equality of (path, op, sha) — order-insensitive.
    const key = (e: FsEffect) => `${e.path}|${e.op}|${e.sha256}`;
    const sa = [...a].map(key).sort();
    const sb = [...b].map(key).sort();
    return sa.length === sb.length && sa.every((k, i) => k === sb[i])
      ? "match"
      : "mismatch";
  }
  if (policy.mode === "normalize") {
    // normalize: compare sorted by path but allow sha drift on text files —
    // MVP treats identical effect sets as equal regardless of content hash.
    const ka = a.map((e) => `${e.path}|${e.op}`).sort();
    const kb = b.map((e) => `${e.path}|${e.op}`).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i])
      ? "match"
      : "mismatch";
  }
  return a.length === b.length && a.every((e, i) => eqEffect(e, b[i]!))
    ? "match"
    : "mismatch"; // exact: ordered, hash-identical
}

function eqEffect(
  x: { path: string; op: string; sha256: string | null },
  y: { path: string; op: string; sha256: string | null },
): boolean {
  return x.path === y.path && x.op === y.op && x.sha256 === y.sha256;
}

export function compare(
  contract: BehaviorContract,
  baseline: ObservationTrace,
  candidate: ObservationTrace,
): ComparisonResultInput {
  const baseById = new Map(baseline.observations.map((o) => [o.case_id, o]));

  const per_case = candidate.observations.map((cand) => {
    const base = baseById.get(cand.case_id);
    if (!base) {
      return {
        case_id: cand.case_id,
        verdict: "mismatch" as const,
        channels: {},
        detail: "no baseline observation for this case",
      };
    }
    // Baseline-side failures are skipped (R3 already gated scope-related ones);
    // preexisting_behavior must REPRODUCE in the candidate.
    if (base.status !== "observed") {
      const reproduced =
        cand.status !== "observed" && cand.exit_code === base.exit_code;
      return {
        case_id: cand.case_id,
        verdict: reproduced ? ("match" as const) : ("mismatch" as const),
        channels: {},
        detail: reproduced
          ? "baseline failure reproduced identically"
          : `baseline ${base.status} (exit ${base.exit_code}) not reproduced (candidate exit ${cand.exit_code}, status ${cand.status})`,
      };
    }

    const channels: Record<string, Verdict> = {};
    const exitPolicy = contract.channels.exit_code.mode;
    channels["exit_code"] =
      exitPolicy === "ignore"
        ? "not_compared"
        : cand.exit_code === base.exit_code
          ? "match"
          : "mismatch";
    channels["signals"] =
      cand.signal === base.signal ? "match" : "mismatch";
    channels["stdout"] = compareBytes(
      contract.channels.stdout.mode,
      base.stdout_b64,
      cand.stdout_b64,
    );
    channels["stderr"] = compareBytes(
      contract.channels.stderr.mode,
      base.stderr_b64,
      cand.stderr_b64,
    );

    const mismatched = Object.entries(channels)
      .filter(([, v]) => v === "mismatch")
      .map(([k]) => k);

    return {
      case_id: cand.case_id,
      verdict: mismatched.length > 0 ? ("mismatch" as const) : ("match" as const),
      channels,
      detail:
        mismatched.length > 0 ? `channels differ: ${mismatched.join(", ")}` : "",
    };
  });

  return {
    kind: "comparison-result",
    version: 1,
    baseline_env_id: baseline.env_id,
    candidate_env_id: candidate.env_id,
    per_case,
  };
}
