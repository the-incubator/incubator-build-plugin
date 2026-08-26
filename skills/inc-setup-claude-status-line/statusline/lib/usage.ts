import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface UsageLimit {
  kind: string; // "session" | "weekly_all" | "weekly_scoped"
  group: string;
  percent: number;
  resets_at: string;
  scope: { model: { display_name: string | null } | null } | null;
}

interface UsageCache {
  fetchedAt: number;
  limits: UsageLimit[];
}

const TTL_MS = 60_000;

interface ClaudeProfilePaths {
  cacheFile: string;
  keychainService: string;
}

/** Resolve the same per-profile paths Claude Code uses on macOS. */
export function getClaudeProfilePaths(
  env: Record<string, string | undefined> = process.env,
): ClaudeProfilePaths {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const secureStorageDir =
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR;

  let keychainService = "Claude Code-credentials";
  if (secureStorageDir) {
    const digest = createHash("sha256")
      .update(secureStorageDir.normalize("NFC"), "utf8")
      .digest("hex")
      .slice(0, 8);
    keychainService += `-${digest}`;
  }

  return {
    cacheFile: join(configDir, "cache", "usage.json"),
    keychainService,
  };
}

function readCache(cacheFile: string): UsageCache | null {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf-8")) as UsageCache;
  } catch {
    return null;
  }
}

async function fetchLimits(keychainService: string): Promise<UsageLimit[]> {
  const creds = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", keychainService, "-w"],
    { encoding: "utf-8", timeout: 2000 },
  );
  const token = JSON.parse(creds).claudeAiOauth.accessToken as string;

  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
  const body = (await res.json()) as { limits?: UsageLimit[] };
  if (!Array.isArray(body.limits)) throw new Error("no limits in response");
  return body.limits;
}

/** Rate-limit usage, cached for 60s; serves stale data if the fetch fails. */
export async function getUsageLimits(): Promise<UsageLimit[] | null> {
  const { cacheFile, keychainService } = getClaudeProfilePaths();
  const cached = readCache(cacheFile);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.limits;

  try {
    const limits = await fetchLimits(keychainService);
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(
      cacheFile,
      JSON.stringify({ fetchedAt: Date.now(), limits } satisfies UsageCache),
    );
    return limits;
  } catch {
    return cached?.limits ?? null;
  }
}

