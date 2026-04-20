// Client-side secret redaction for transcripts. Runs locally, before anything leaves the machine.
//
// Pattern order matters: more-specific patterns run first so the `[REDACTED:...]` replacement
// doesn't get shadowed by a broader pattern later in the list.
//
// Trade-offs:
// - Regex can't catch unknown secret shapes. Entropy-based detection is out of scope.
// - False positives are preferable to false negatives for this code's purpose (stopping secrets).

const PATTERNS = Object.freeze([
  {
    kind: "private-key",
    // Handles RSA, EC, OPENSSH, DSA, PGP, etc. `[\s\S]` to span newlines.
    re: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    replace: () => "[REDACTED:private-key]",
  },
  {
    kind: "stripe-key",
    re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{24,}\b/g,
    replace: () => "[REDACTED:stripe-key]",
  },
  {
    kind: "anthropic-key",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => "[REDACTED:anthropic-key]",
  },
  {
    kind: "openai-key",
    // Run AFTER anthropic so sk-ant- wins; openai keys otherwise start with plain sk-.
    re: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replace: () => "[REDACTED:openai-key]",
  },
  {
    kind: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    replace: () => "[REDACTED:github-token]",
  },
  {
    kind: "github-token",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: () => "[REDACTED:github-token]",
  },
  {
    kind: "aws-key-id",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => "[REDACTED:aws-key-id]",
  },
  {
    kind: "google-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => "[REDACTED:google-key]",
  },
  {
    kind: "slack-token",
    re: /\bxox[abprs]-[0-9]+-[0-9]+-[0-9]+-[0-9a-f]+\b/g,
    replace: () => "[REDACTED:slack-token]",
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: () => "[REDACTED:jwt]",
  },
  {
    kind: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: () => "[REDACTED:email]",
  },
  {
    kind: "unix-home-path",
    re: /\/Users\/[^/\s"]+/g,
    replace: () => "/Users/[REDACTED]",
  },
  {
    kind: "unix-home-path",
    re: /\/home\/[^/\s"]+/g,
    replace: () => "/home/[REDACTED]",
  },
  {
    kind: "windows-home-path",
    re: /([A-Z]):\\Users\\[^\\/\s"]+/g,
    replace: (_match, drive) => `${drive}:\\Users\\[REDACTED]`,
  },
  {
    kind: "bearer-header",
    re: /Authorization:\s*Bearer\s+\S+/gi,
    replace: () => "Authorization: Bearer [REDACTED]",
  },
]);

export function redactLine(line) {
  const counts = Object.create(null);
  let out = line;
  for (const p of PATTERNS) {
    let hit = 0;
    out = out.replace(p.re, (...args) => {
      hit += 1;
      return p.replace(...args);
    });
    if (hit > 0) counts[p.kind] = (counts[p.kind] ?? 0) + hit;
  }
  return { text: out, counts };
}

export function mergeCounts(a, b) {
  for (const [k, v] of Object.entries(b)) {
    a[k] = (a[k] ?? 0) + v;
  }
  return a;
}

export { PATTERNS };
