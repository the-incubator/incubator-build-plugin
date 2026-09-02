import { execSync } from "child_process";
import { computePace, paceBadge, WEEK_MS } from "./lib/pace.js";
import { readStdin } from "./lib/read-stdin.js";
import { getUsageLimits, type UsageLimit } from "./lib/usage.js";
import type { StatusLineInput } from "./types/statusline-input.js";

// Warning tiers shared by the bar color and the session reset countdown, so the
// countdown appears exactly when the bar turns yellow.
const WARN_PCT = 70;
const CRIT_PCT = 90;

// 5-cell bar + colored percent, e.g. "▰▱▱▱▱  23%"
// Always colored (green/yellow/red) so it reads at a glance even at low %.
function usageBar(percent: number): string {
  if (!Number.isFinite(percent)) percent = 0;
  percent = Math.min(100, Math.max(0, percent));
  const filled = Math.min(5, Math.floor(percent / 20));
  // Muted sage for normal so it reads without shouting; yellow/red for warning tiers
  const color =
    percent >= CRIT_PCT
      ? "\x1b[31m"
      : percent >= WARN_PCT
        ? "\x1b[33m"
        : "\x1b[38;5;108m";
  const bar =
    color +
    "▰".repeat(filled) +
    "\x1b[0m\x1b[2m" +
    "▱".repeat(5 - filled) +
    "\x1b[0m";
  return `${bar}  ${color}${Math.round(percent)}%\x1b[0m`;
}

// Compact time-until-reset, e.g. "↻6d" / "↻30h" / "↻95m".
// Below 2 days it switches to hours so "1d" never hides how many hours remain,
// and below 2 hours to minutes so a 5h-window countdown is not rounded to "2h".
function resetIn(resetsAt: string): string | null {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3_600_000;
  const label =
    hours >= 48
      ? `${Math.round(hours / 24)}d`
      : hours >= 2
        ? `${Math.round(hours)}h`
        : `${Math.max(1, Math.round(ms / 60_000))}m`;
  return `\x1b[2m↻ ${label}\x1b[0m`;
}

function usageSegment(limits: UsageLimit[]): string {
  const session = limits.find((l) => l.kind === "session");
  const weekly = limits.find((l) => l.kind === "weekly_all");
  const scoped = limits.find((l) => l.kind === "weekly_scoped");
  const parts: string[] = [];
  if (session) {
    // Once the 5h window is in the warning zone, the question is "how soon
    // does it come back", so show the countdown there too.
    const reset =
      session.percent >= WARN_PCT ? resetIn(session.resets_at) : null;
    parts.push(`5h ${usageBar(session.percent)}${reset ? ` ${reset}` : ""}`);
  }
  if (scoped) {
    const name = scoped.scope?.model?.display_name ?? "Model";
    const pace = paceBadge(
      computePace(scoped.percent, scoped.resets_at, WEEK_MS),
    );
    parts.push(
      `${name} ${usageBar(scoped.percent)}${pace ? ` ${pace}` : ""}`,
    );
  }
  if (weekly) {
    const reset = resetIn(weekly.resets_at);
    const pace = paceBadge(
      computePace(weekly.percent, weekly.resets_at, WEEK_MS),
    );
    parts.push(
      `Wk ${usageBar(weekly.percent)}${pace ? ` ${pace}` : ""}${reset ? ` ${reset}` : ""}`,
    );
  }
  return parts.join("  ");
}

async function main() {
  const input = await readStdin<StatusLineInput>();

  // Strip context-size suffixes like " (1M context)" from the display name
  const model = input.model.display_name.replace(/\s*\(1M context\)/i, "");
  const usedPct = input.context_window.used_percentage;
  const ctxPct = usedPct != null ? Math.round(usedPct) : null;
  const project = input.workspace.project_dir.split("/").pop() ?? "";
  const style = input.output_style?.name ?? "";

  // Color-code context: red >70% (compaction at 82%), yellow >50%
  let ctxStr: string | null = null;
  if (ctxPct != null) {
    if (ctxPct > 70) {
      ctxStr = `\x1b[31m${ctxPct}%\x1b[0m`;
    } else if (ctxPct > 50) {
      ctxStr = `\x1b[33m${ctxPct}%\x1b[0m`;
    } else {
      ctxStr = `${ctxPct}%`;
    }
  }

  // Git branch
  let branch = "";
  try {
    branch = execSync(
      `git -C "${input.workspace.project_dir}" --no-optional-locks branch --show-current`,
      { encoding: "utf-8", timeout: 2000 },
    ).trim();
  } catch {
    // Not a git repo or git unavailable
  }

  // Build output
  let out = model;
  if (input.effort?.level) {
    out += ` \x1b[2m(${input.effort.level})\x1b[0m`;
  }
  if (style && style !== "null" && style !== "default") {
    out += ` [${style}]`;
  }
  if (ctxStr != null) {
    out += ` | Context: ${ctxStr}`;
  }
  if (project) {
    out += branch ? ` | ${project} (${branch})` : ` | ${project}`;
  }

  // Usage bars on their own line so long worktree names can't push them off-screen.
  // Claude session/week from Anthropic OAuth. Never let a usage failure blank
  // the whole status bar: fall back to the base line alone.
  try {
    const limits = await getUsageLimits();
    const seg = limits ? usageSegment(limits) : "";
    if (seg) out += `\n${seg}`;
  } catch {
    // usage unavailable; base line still renders
  }

  process.stdout.write(out);
}

main().catch(() => process.exit(0));
