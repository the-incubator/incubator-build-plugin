// Pace vs a quota window: how fast tokens are burning relative to how far
// into the window we are. ratio 1.0 = on track to land exactly at 100% when
// the window resets; above = running out early, below = leaving quota unused.

export const WEEK_MS = 7 * 24 * 3_600_000;

export interface Pace {
  ratio: number; // used-fraction / elapsed-fraction of the window
  tier: "hot" | "warm" | "on" | "under";
}

export function computePace(
  percentUsed: number,
  resetsAt: string,
  windowMs: number,
  now: number = Date.now(),
): Pace | null {
  const remain = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(remain) || remain <= 0 || remain >= windowMs) {
    return null;
  }
  const elapsed = 1 - remain / windowMs;
  if (elapsed < 0.03) return null; // window just reset; the ratio is noise
  const ratio = percentUsed / 100 / elapsed;
  const tier =
    ratio >= 1.25 ? "hot" : ratio >= 1.1 ? "warm" : ratio > 0.75 ? "on" : "under";
  return { ratio, tier };
}

// Compact colored badge shown after the usage percent, e.g. "(1.4x)".
// Color carries the verdict: red = too hot, yellow = slightly hot,
// sage = on pace, cyan = under-using. Empty string when pace is unknown.
export function paceBadge(pace: Pace | null): string {
  if (!pace) return "";
  // One decimal, but flat numbers stay flat: 1.0 -> "1", 0.5 -> "0.5"
  const r =
    pace.ratio >= 10
      ? `${Math.round(pace.ratio)}`
      : `${Number(pace.ratio.toFixed(1))}`;
  const color =
    pace.tier === "hot"
      ? "\x1b[31m"
      : pace.tier === "warm"
        ? "\x1b[33m"
        : pace.tier === "on"
          ? "\x1b[38;5;108m"
          : "\x1b[36m";
  return `${color}(${r}x)\x1b[0m`;
}
