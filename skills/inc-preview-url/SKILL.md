---
name: inc:preview-url
description: Use when the user wants a public URL to reach their locally-running app from another device or share it with someone. Spins up a Cloudflare quick tunnel (cloudflared) that maps a *.trycloudflare.com URL to a local port — no Cloudflare account or domain required. Triggers on "preview url", "share my app", "expose my app", "public URL for localhost", "share my local app", "access the app remotely", "tunnel", "ngrok-style URL", "cloudflare tunnel", or "/inc:preview-url".
allowed-tools: Read, Grep, Glob, AskUserQuestion, Bash(cloudflared *), Bash(lsof *), Bash(which *), Bash(curl *), Bash(jq *), Bash(cat *), Bash(npm *), Bash(pnpm *), Bash(yarn *), Bash(bun *), Bash(pkill *), Bash(kill *)
argument-hint: "[optional: port or local URL, e.g. 5173 or http://localhost:5173]"
---

# Tunnel — Public Cloudflare URL for a Local App

Expose a locally-running app at a public `https://<random>.trycloudflare.com` URL using a
**Cloudflare quick tunnel** (`cloudflared`). Quick tunnels need **no Cloudflare account, login, or
domain** — they're the fastest way to reach a dev server from a phone, a teammate, or a webhook.

The URL is **ephemeral** (new random hostname each run) and **unauthenticated** (anyone with the
link reaches the app). That's the right trade-off for quick remote access and demos; call it out so
the user isn't surprised.

## User-invocable

When the user types `/inc:preview-url`, run this skill. An optional argument is the port or local URL to
expose (e.g. `/inc:preview-url 5173` or `/inc:preview-url http://localhost:3000`) — use it to skip detection.

## Step 1 — Determine the local target

Resolve a single `http://localhost:<PORT>` (or `http://127.0.0.1:<PORT>`) to expose.

1. **Argument wins.** If the user passed a port, target `http://localhost:<port>`. If they passed a
   full URL, use it verbatim.
2. **Otherwise detect what's listening locally:**

   ```bash
   lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'localhost|127\.0\.0\.1|\*:' | grep -vE ':(22|53|631|5432|3306|6379|27017|11434)\b'
   ```

   This lists listening sockets, dropping common infra ports (databases, SSH) so dev servers stand
   out. Typical dev ports: 3000, 3001, 4321, 5173, 8000, 8080, 8787, 19006.
3. **Hint from project config** if detection is ambiguous — read `package.json` (`scripts.dev`),
   `vite.config.*`, `next.config.*`, or `deploy.md` for a configured dev port.
4. **Decide:**
   - Exactly one obvious dev port → use it, but tell the user which port you picked.
   - Multiple candidates → ask with `AskUserQuestion`.
   - Nothing listening → the app isn't running. Don't tunnel to a dead port — go to Step 1b and
     offer to start it.

**Success criteria:** A single concrete local URL is chosen and stated to the user.

## Step 1b — Offer to start the app (only if nothing is listening)

If no server was found, look for a start command in `package.json` before giving up:

```bash
cat package.json 2>/dev/null | jq -r '.scripts | to_entries[] | "\(.key): \(.value)"' 2>/dev/null
```

Pick the most likely script — prefer `dev`, then `start`, then a `dev:*`/`serve` variant — and read
its command to infer the port (e.g. `next dev -p 1000`, `vite --port 5173`, `PORT=3000 ...`). If the
port isn't in the script, fall back to the framework default (Next `3000`, Vite `5173`, etc.).

Then **ask with `AskUserQuestion`** — don't auto-launch a long-running process:
- A) **Start `<script>` for me** → run `npm run <script>` (or the repo's pm: `pnpm`/`yarn`/`bun`) with
  `run_in_background: true`, then poll `lsof`/`curl` until the port is listening (give it ~20–30s;
  dev servers take a moment to boot). Once up, continue to Step 2.
- B) **I'll start it myself** → tell them the command and stop; they re-run `/inc:preview-url` after.

If `package.json` has no usable script (or there's no `package.json`), say so and ask the user for the
start command or port rather than guessing. Note the dev server stays running in the background after
the tunnel — mention how to stop it alongside the tunnel-stop line in the final report.

## Step 2 — Sanity-check the local app

```bash
curl -sf -o /dev/null -w "%{http_code}" http://localhost:<PORT> || echo "NO_LOCAL_RESPONSE"
```

A `200`/`3xx`/`4xx` means something is serving. `NO_LOCAL_RESPONSE` or `000` means nothing answered
— warn the user the local app may be down, but allow proceeding if they confirm (some apps only
answer specific paths or reject bare requests).

## Step 3 — Ensure cloudflared is installed

```bash
which cloudflared || echo "CLOUDFLARED_MISSING"
```

If missing, **do not install it yourself** — print the command and let the user run it, then re-probe:

- macOS: `brew install cloudflared`
- Linux / other: see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Suggest the user run it as `! brew install cloudflared` so it executes in this session, then continue.

## Step 4 — Start the quick tunnel

Launch in the background so it stays up across turns, then read its output to capture the URL:

```bash
cloudflared tunnel --url http://localhost:<PORT>
```

Run this with `run_in_background: true`. Then poll the background output for the assigned hostname —
`cloudflared` prints a boxed line containing `https://<random>.trycloudflare.com`. Grab the first
`https://[a-z0-9-]+\.trycloudflare\.com` URL from the output.

If the output shows an error instead (port unreachable, binary blocked by Gatekeeper, network
failure), surface it and stop — don't claim a URL that wasn't issued.

**Success criteria:** A live `*.trycloudflare.com` URL is captured from the running process.

## Step 5 — Verify and report

Confirm the public URL actually reaches the app:

```bash
curl -sf -o /dev/null -w "%{http_code}" https://<random>.trycloudflare.com || echo "TUNNEL_NOT_READY"
```

It can take a few seconds for the edge route to propagate; one retry is fine. Then report — **keep it
to two lines**: the URL and what it points at. Nothing else.

```
https://<random>.trycloudflare.com → <app name or localhost:<PORT>>
Public + temporary. Stop: pkill -f "cloudflared tunnel"
```

Do **not** print a status box, the forwarding/process internals, security lectures, routing theory,
or HTTP codes. The user knows what they asked for. If the app needs a specific path to show anything
useful (not the bare `/`), append one line with that link — otherwise stay at two lines.

## Notes

- **Quick tunnel vs named tunnel.** This skill uses quick tunnels (zero-config, random hostname). If
  the user wants a **stable custom domain** or **persistent** tunnel, that needs a Cloudflare account
  and `cloudflared tunnel login` + a named tunnel mapped to a DNS record — mention it as the upgrade
  path, but don't run the interactive login yourself; hand the user the commands.
- **Security.** The URL exposes the local app to the public internet with no auth in front of it.
  Don't tunnel anything holding real secrets or production data without the user's explicit OK. For
  access control, Cloudflare Access (named tunnels) is the proper gate.
- **One tunnel per port.** If a `cloudflared tunnel` is already running for this port, reuse/report it
  rather than starting a duplicate.

## Guardrails

- Never run `brew install` or `cloudflared tunnel login` yourself — print the command, let the user run it.
- Never tunnel to a port nothing is listening on; confirm the app is up first.
- Never report a `trycloudflare.com` URL you didn't actually read from the process output.
- Keep the final report terse — the URL and what it points at. The "public + temporary" note is one
  line, not a paragraph. Don't explain the app's routing unless the bare `/` shows nothing useful.
