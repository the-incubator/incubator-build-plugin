#!/usr/bin/env node
/**
 * Render a mobile feedback bundle (ibf-mobile-rrweb) to recording.webm.
 *
 * Mobile browsers cannot capture screen pixels (no getDisplayMedia), so the
 * preview-feedback client records the DOM as an rrweb event stream instead.
 * This script replays that stream in headless Chromium and captures the replay
 * as video - producing the same recording.webm the rest of the analyzer
 * pipeline already understands.
 *
 * The voice track is deliberately NOT muxed into the video: riffrec's own
 * recording.webm is video-only, and the report plays the bundle's separate
 * voice file alongside the video. Embedding it too would narrate twice.
 *
 * Usage:
 *   node render_rrweb_bundle.mjs <bundle-dir-or-zip> [--out <recording.webm>]
 *
 * Input: an extracted bundle directory (or the zip itself) containing
 * session.json (format "ibf-mobile-rrweb") and rrweb-events.json.
 *
 * Dependencies (all local to this machine, resolved at run time):
 *   - playwright with Chromium (npm i playwright && npx playwright install chromium)
 *   - ffmpeg (optional: trims the pre-playback head frame-accurately; without
 *     it the render keeps a short blank head)
 *   - network access to cdn.jsdelivr.net (pinned rrweb replayer; override with
 *     RRWEB_REPLAY_VERSION)
 *
 * Exit codes: 0 rendered; 2 bad input; 3 missing dependency (message says how
 * to install); 4 render failure.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, copyFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// @rrweb/replay (not the full rrweb package): its /umd build is the one
// artifact jsdelivr serves as executable JavaScript - rrweb's own dist ships
// .cjs files that Chromium refuses to run from a CDN (application/node +
// nosniff).
const RRWEB_VERSION = process.env.RRWEB_REPLAY_VERSION || "2.1.0";
const CDN = `https://cdn.jsdelivr.net/npm/@rrweb/replay@${RRWEB_VERSION}`;
// Chromium's own tab height floor; also caps runaway viewports from bad manifests.
const MAX_VIEWPORT = 1920;

// Temp-dir teardown routed through here because fail() uses process.exit(),
// which skips finally blocks - a naive try/finally would leak the captured
// video (and extracted zip) on every failure path.
const cleanups = [];
function runCleanups() {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function fail(code, message) {
  runCleanups();
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { bundle: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (!args.bundle) args.bundle = argv[i];
  }
  if (!args.bundle) fail(2, "usage: render_rrweb_bundle.mjs <bundle-dir-or-zip> [--out <path>]");
  return args;
}

function extractIfZip(bundlePath) {
  if (statSync(bundlePath).isDirectory()) return bundlePath;
  const dir = mkdtempSync(join(tmpdir(), "ibf-rrweb-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync("unzip", ["-o", "-q", bundlePath, "-d", dir]);
  } catch (err) {
    fail(2, `could not extract ${bundlePath}: ${err?.message ?? err}`);
  }
  return dir;
}

// A bare import resolves from this script's own location (the plugin install,
// which never has node_modules), so also resolve from the invoking directory -
// that makes "npm i playwright" in the product repo just work.
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    /* fall through */
  }
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(join(process.cwd(), "__resolve__.js"));
    const mod = await import(pathToFileURL(req.resolve("playwright")).href);
    return mod.chromium ? mod : (mod.default ?? mod);
  } catch {
    fail(
      3,
      "playwright is not installed.\n" +
        "Fix (from the product repo or any working directory): npm i playwright && npx playwright install chromium",
    );
  }
}

function ffmpegAvailable() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

// Escape "</script>" inside the inlined JSON so it cannot close our tag.
function inlineJson(json) {
  return json.replace(/<\//g, "<\\/");
}

function playerHtml(eventsJson) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${CDN}/dist/style.min.css">
<style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; }
  .replayer-wrapper { transform-origin: top left; }
  iframe { border: none; }
</style>
</head>
<body>
<script src="${CDN}/umd/replay.min.js"></script>
<script>window.__EVENTS__ = ${inlineJson(eventsJson)};</script>
<script>
  window.__DONE__ = false;
  window.__READY__ = false;
  window.__ERROR__ = null;
  try {
    var replayer = new rrwebReplay.Replayer(window.__EVENTS__, {
      root: document.body,
      speed: 1,
      skipInactive: false,
      mouseTail: false,
      showWarning: false,
    });
    replayer.on("finish", function () { window.__DONE__ = true; });
    window.__START__ = function () { replayer.play(); };
    window.__READY__ = true;
  } catch (err) {
    window.__ERROR__ = String(err && err.message || err);
  }
</script>
</body>
</html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundlePath = resolve(args.bundle);
  if (!existsSync(bundlePath)) fail(2, `no such file or directory: ${bundlePath}`);
  const dir = extractIfZip(bundlePath);

  const sessionPath = join(dir, "session.json");
  const eventsPath = join(dir, "rrweb-events.json");
  if (!existsSync(sessionPath) || !existsSync(eventsPath)) {
    fail(2, `not a mobile rrweb bundle (need session.json + rrweb-events.json in ${dir})`);
  }
  const session = JSON.parse(readFileSync(sessionPath, "utf8"));
  if (session.format !== "ibf-mobile-rrweb") {
    fail(2, `session.json format is ${JSON.stringify(session.format)}, expected "ibf-mobile-rrweb"`);
  }
  const eventsJson = readFileSync(eventsPath, "utf8");
  const events = JSON.parse(eventsJson);
  if (!Array.isArray(events) || events.length < 2) {
    fail(2, `rrweb-events.json has ${Array.isArray(events) ? events.length : "no"} events - nothing to replay`);
  }

  // Prefer the true event span over the manifest (the manifest includes
  // pre-snapshot setup time).
  const spanMs = events[events.length - 1].timestamp - events[0].timestamp;
  const durationMs = Math.max(1000, Math.min(spanMs || 0, session.durationMs || spanMs || 0) || spanMs);
  const width = Math.min(Math.max(session.viewport?.width || 390, 320), MAX_VIEWPORT);
  const height = Math.min(Math.max(session.viewport?.height || 844, 320), MAX_VIEWPORT);
  const outPath = resolve(args.out || join(statSync(bundlePath).isDirectory() ? bundlePath : dirname(bundlePath), "recording.webm"));

  const { chromium } = await loadPlaywright();
  const workDir = mkdtempSync(join(tmpdir(), "ibf-render-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  const htmlPath = join(workDir, "player.html");
  writeFileSync(htmlPath, playerHtml(eventsJson));

  process.stderr.write(
    `rendering ${events.length} events, ~${Math.round(durationMs / 1000)}s at ${width}x${height} (video only - the report pairs the voice track)\n`,
  );

  const browser = await chromium.launch();
  let videoPath;
  let playOffsetMs = 0;
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: workDir, size: { width, height } },
    });
    const page = await context.newPage();
    const captureStart = Date.now();
    await page.goto(pathToFileURL(htmlPath).href);
    await page.waitForFunction("window.__READY__ || window.__ERROR__", null, { timeout: 60_000 });
    const pageError = await page.evaluate("window.__ERROR__");
    if (pageError) throw new Error(`replayer failed to initialize: ${pageError} (is cdn.jsdelivr.net reachable?)`);
    playOffsetMs = Date.now() - captureStart;
    await page.evaluate("window.__START__()");
    await page.waitForFunction("window.__DONE__", null, {
      timeout: Math.max(durationMs * 1.5, durationMs + 30_000),
    });
    // A short tail so the final frame lands in the capture.
    await page.waitForTimeout(500);
    const video = page.video();
    await context.close(); // finalizes the video file
    videoPath = await video.path();
  } finally {
    await browser.close();
  }

  // Trim the pre-playback head. The report syncs the bundle's voice track to
  // video time, so the trim must be frame-accurate - re-encode rather than
  // stream-copy (copy can only cut on a preceding keyframe, leaving part of
  // the blank page-load head and shifting audio alignment).
  if (ffmpegAvailable()) {
    const ff = spawnSync(
      "ffmpeg",
      ["-y", "-ss", (playOffsetMs / 1000).toFixed(3), "-i", videoPath, "-c:v", "libvpx", "-b:v", "1M", "-crf", "12", "-an", outPath],
      { encoding: "utf8" },
    );
    if (ff.status !== 0) {
      fail(4, `ffmpeg failed:\n${(ff.stderr || "").split("\n").slice(-12).join("\n")}`);
    }
  } else {
    // Usable but with ~playOffsetMs of blank head; voice sync in the report
    // will be off by the same amount.
    copyFileSync(videoPath, outPath);
    process.stderr.write(
      `ffmpeg not found - kept a ~${playOffsetMs}ms blank head (brew install ffmpeg for a trimmed, voice-aligned render)\n`,
    );
  }
  runCleanups();

  process.stdout.write(`RENDERED=${outPath}\n`);
  process.stdout.write(`RENDER_DURATION_MS=${durationMs}\n`);
  process.stdout.write(`RENDER_HEAD_TRIM_MS=${playOffsetMs}\n`);
}

main().catch((err) => fail(4, `render failed: ${err?.stack ?? err}`));
