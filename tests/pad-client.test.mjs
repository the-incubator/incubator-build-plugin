// User-visible behavior of `inc-build pad ...` against a mock IncPad server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createRawServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(root, "scripts/inc-build.mjs");

async function mockServer(t, handle) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const record = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(record);
      const reply = handle(record, requests.length) ?? { status: 404, json: { reason: "not_found" } };
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}` };
}

function home(t, endpoint) {
  const dir = mkdtempSync(join(tmpdir(), "inc-pad-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ apiKey: "org_key_123", endpoint }));
  return dir;
}

// Async so the in-process mock server can answer while the CLI runs.
function run(homeDir, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, INCUBATOR_HOME: homeDir } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function fixtures(t) {
  const dir = mkdtempSync(join(tmpdir(), "inc-pad-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const html = "<!doctype html><html><head><title>Launch  Plan</title></head><body><h1>Hi</h1></body></html>";
  writeFileSync(join(dir, "plan.html"), html);
  const folder = join(dir, "site");
  mkdirSync(join(folder, "assets"), { recursive: true });
  mkdirSync(join(folder, ".git"), { recursive: true });
  writeFileSync(join(folder, "index.html"), "<html><body><img src='assets/logo.png'></body></html>");
  writeFileSync(join(folder, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(folder, "assets", "app.css"), "body{margin:0}");
  writeFileSync(join(folder, ".git", "HEAD"), "ref: refs/heads/main");
  writeFileSync(join(folder, ".DS_Store"), "junk");
  return { dir, html, single: join(dir, "plan.html"), folder };
}

const created = { id: "pad_1", share_id: "s_abc", url: "https://build.example/pad/s_abc", revision: 1 };

test("pad create uploads a single HTML file inlined and prints the share URL and pad id", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const h = home(t, endpoint);
  const f = fixtures(t);
  const r = await run(h, ["pad", "create", f.single]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `https://build.example/pad/s_abc\npadId: pad_1\nrevision: 1\n`);
  const [req] = requests;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/pads");
  assert.equal(req.auth, "Bearer org_key_123");
  assert.equal(req.body.title, "Launch Plan");
  assert.equal(req.body.entry, "index.html");
  assert.deepEqual(req.body.files, [
    { path: "index.html", content_base64: Buffer.from(f.html).toString("base64"), content_type: "text/html" },
  ]);
});

test("pad create --title overrides the HTML title", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const f = fixtures(t);
  const r = await run(home(t, endpoint), ["pad", "create", f.single, "--title", "Custom"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(requests[0].body.title, "Custom");
});

test("pad create uploads a directory as index.html plus relative-path assets, skipping hidden files", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const f = fixtures(t);
  const r = await run(home(t, endpoint), ["pad", "create", f.folder, "--title", "Site"]);
  assert.equal(r.status, 0, r.stderr);
  const files = requests[0].body.files.map((x) => [x.path, x.content_type, Buffer.from(x.content_base64, "base64")]);
  assert.deepEqual(
    files.map(([p, ct]) => [p, ct]),
    [
      ["assets/app.css", "text/css"],
      ["assets/logo.png", "image/png"],
      ["index.html", "text/html"],
    ],
  );
  assert.deepEqual(files[1][2], Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(requests[0].body.entry, "index.html");
});

test("pad create rejects a directory without index.html and a non-HTML file", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const f = fixtures(t);
  const h = home(t, endpoint);
  writeFileSync(join(f.dir, "notes.txt"), "x");
  mkdirSync(join(f.dir, "empty"));
  const noIndex = await run(h, ["pad", "create", join(f.dir, "empty")]);
  assert.notEqual(noIndex.status, 0);
  assert.match(noIndex.stderr, /no index\.html/);
  const notHtml = await run(h, ["pad", "create", join(f.dir, "notes.txt")]);
  assert.notEqual(notHtml.status, 0);
  assert.match(notHtml.stderr, /not an \.html file/);
  assert.equal(requests.length, 0, "nothing is uploaded when the input is invalid");
});

test("pad update publishes a new revision from the same inputs", async (t) => {
  const { requests, endpoint } = await mockServer(t, (req) =>
    req.path === "/api/v1/pads" ? { json: created } : { json: { revision: 2, url: created.url } },
  );
  const f = fixtures(t);
  const h = home(t, endpoint);
  await run(h, ["pad", "create", f.single]);
  const r = await run(h, ["pad", "update", "pad_1", f.folder]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `revision: 2\nurl: ${created.url}\n`);
  const req = requests[1];
  assert.equal(req.method, "PUT");
  assert.equal(req.path, "/api/v1/pads/pad_1/revisions");
  assert.equal(req.body.title, "Launch Plan", "keeps the title from create when the new HTML has none");
  assert.deepEqual(req.body.files.map((x) => x.path), ["assets/app.css", "assets/logo.png", "index.html"]);
});

test("pad poll keeps checking until feedback arrives, prints it, and never re-delivers it", async (t) => {
  const items = [
    { id: "f1", kind: "comment", text: "Make this bigger", selector: "h1", selected_text: "Hi", created_at: "2026-09-25T00:00:00Z" },
    { id: "f2", kind: "prompt", text: "Add a pricing table", selector: null, selected_text: null, created_at: "2026-09-25T00:00:01Z" },
  ];
  let feedbackCalls = 0;
  const { requests, endpoint } = await mockServer(t, (req) => {
    if (req.path !== "/api/v1/pads/pad_1/feedback") return { json: created };
    feedbackCalls++;
    if (feedbackCalls < 3) return { json: { items: [], cursor: req.query.after || "" } };
    if (feedbackCalls === 3) return { json: { items, cursor: "c2" } };
    return { json: { items: [], cursor: "c2" } };
  });
  const h = home(t, endpoint);
  const r = await run(h, ["pad", "poll", "pad_1", "--interval", "0.05"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { items, cursor: "c2" });
  const polls = requests.filter((x) => x.path.endsWith("/feedback"));
  assert.equal(polls.length, 3);
  assert.deepEqual(polls[0].query, {}, "first poll has no cursor");

  const again = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), { items: [], cursor: "c2" });
  assert.equal(requests.at(-1).query.after, "c2", "the persisted cursor is sent so feedback is not re-delivered");

  const state = JSON.parse(readFileSync(join(h, "pads", "pad_1.json"), "utf8"));
  assert.equal(state.cursor, "c2");
});

test("pad poll gives up cleanly at --timeout with an empty result", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c0" } }));
  const r = await run(home(t, endpoint), ["pad", "poll", "pad_9", "--interval", "0.05", "--timeout", "0.2"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { items: [], cursor: "c0" });
  assert.ok(requests.length >= 2 && requests.length <= 6, `polled ${requests.length} times`);
});

test("pad poll --reset re-delivers from the beginning", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c5" } }));
  const h = home(t, endpoint);
  await run(h, ["pad", "poll", "pad_1", "--once"]);
  await run(h, ["pad", "poll", "pad_1", "--once", "--reset"]);
  assert.equal(requests[0].query.after, undefined);
  assert.equal(requests[1].query.after, undefined);
});

test("pad reply posts the agent's message and pad end closes the review", async (t) => {
  const { requests, endpoint } = await mockServer(t, (req) =>
    req.path.endsWith("/replies") ? { json: { id: "r1" } } : { json: { ended: true } },
  );
  const h = home(t, endpoint);
  const reply = await run(h, ["pad", "reply", "pad_1", "Made", "the", "heading", "bigger"]);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stdout, "replyId: r1\n");
  assert.deepEqual(requests[0], {
    method: "POST",
    path: "/api/v1/pads/pad_1/replies",
    query: {},
    auth: "Bearer org_key_123",
    body: { text: "Made the heading bigger" },
  });
  const end = await run(h, ["pad", "end", "pad_1"]);
  assert.equal(end.status, 0, end.stderr);
  assert.equal(end.stdout, "ended: true\n");
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].path, "/api/v1/pads/pad_1/end");
});

test("server errors surface with the API's reason and an auth-specific exit code", async (t) => {
  const { endpoint } = await mockServer(t, () => ({ status: 401, json: { reason: "invalid_api_key" } }));
  const f = fixtures(t);
  const r = await run(home(t, endpoint), ["pad", "create", f.single]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /POST \/api\/v1\/pads failed \(401\): invalid_api_key/);
});

test("retired plan commands point at IncPad", async (t) => {
  const { endpoint } = await mockServer(t, () => ({ json: {} }));
  const r = await run(home(t, endpoint), ["plan", "create", "--project", "x"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /moved to IncPad/);
  assert.match(r.stderr, /pad create/);
});

test("pad poll stops immediately when the review has ended", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c1", ended: true } }));
  const h = home(t, endpoint);
  const r = await run(h, ["pad", "poll", "pad_1", "--interval", "0.05"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { items: [], cursor: "c1", ended: true });
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(readFileSync(join(h, "pads", "pad_1.json"), "utf8")).cursor, "c1");
});

test("pad poll replays a batch that was saved but never delivered, then clears it", async (t) => {
  const pending = [{ id: "f9", kind: "prompt", text: "Undelivered", selector: null, selected_text: null, created_at: "2026-09-25T00:00:00Z" }];
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c7" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c7", pending }));
  const replay = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout), { items: pending, cursor: "c7", replayed: true });
  assert.equal(requests.length, 0, "a replay needs no server round trip");
  const again = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.deepEqual(JSON.parse(again.stdout), { items: [], cursor: "c7" });
  assert.equal(requests[0].query.after, "c7");
});

test("pad poll --after is persisted so later polls do not rewind", async (t) => {
  const { requests, endpoint } = await mockServer(t, (req) => ({ json: { items: [], cursor: req.query.after ?? "" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "old" }));
  await run(h, ["pad", "poll", "pad_1", "--once", "--after", "newer"]);
  await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.deepEqual(requests.map((r) => r.query.after), ["newer", "newer"]);
});

test("pad poll exits within --timeout even when the server never answers", async (t) => {
  const server = createRawServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.closeAllConnections?.() ?? server.close());
  const h = home(t, `http://127.0.0.1:${server.address().port}`);
  const started = Date.now();
  const r = await run(h, ["pad", "poll", "pad_1", "--timeout", "1"]);
  assert.ok(Date.now() - started < 10_000, "did not hang");
  assert.equal(r.status, 3);
  assert.match(r.stderr, /timed out/);
});

test("a corrupt pad state file is reported instead of silently re-delivering feedback", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c1" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), "{not json");
  const r = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /corrupt/);
  assert.equal(requests.length, 0);
});

test("pad create still reports the pad when local state cannot be saved", async (t) => {
  const { endpoint } = await mockServer(t, () => ({ json: created }));
  const h = home(t, endpoint);
  const f = fixtures(t);
  writeFileSync(join(h, "pads"), "a file where the pads directory should be");
  const r = await run(h, ["pad", "create", f.single]);
  assert.equal(r.status, 4);
  assert.match(r.stdout, /^https:\/\/build\.example\/pad\/s_abc\npadId: pad_1/);
  assert.match(r.stderr, /server accepted the request but local pad state was not saved/);
});

test("unknown flags are rejected and --help works without credentials", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: {} }));
  const h = home(t, endpoint);
  const typo = await run(h, ["pad", "poll", "pad_1", "--tiemout", "30"]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown flag --tiemout/);
  assert.match(typo.stderr, /--timeout/);
  assert.equal(requests.length, 0);
  const empty = mkdtempSync(join(tmpdir(), "inc-pad-nocreds-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  for (const args of [["pad", "--help"], ["pad", "create", "--help"]]) {
    const help = await run(empty, args);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /pad create <file-or-dir>/);
  }
});

test("directory uploads skip symlinks so nothing outside the artifact directory is published", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const f = fixtures(t);
  writeFileSync(join(f.dir, "secret.json"), "{\"apiKey\":\"x\"}");
  symlinkSync(join(f.dir, "secret.json"), join(f.folder, "assets", "config.json"));
  symlinkSync(f.folder, join(f.folder, "assets", "loop"));
  const r = await run(home(t, endpoint), ["pad", "create", f.folder, "--title", "Site"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(requests[0].body.files.map((x) => x.path), ["assets/app.css", "assets/logo.png", "index.html"]);
  assert.match(r.stderr, /skipping symlink assets\/config\.json/);
});

test("a title set on pad update sticks for later untitled updates", async (t) => {
  const { requests, endpoint } = await mockServer(t, (req) =>
    req.path === "/api/v1/pads" ? { json: created } : { json: { revision: 2, url: created.url } },
  );
  const f = fixtures(t);
  const h = home(t, endpoint);
  await run(h, ["pad", "create", f.single]);
  await run(h, ["pad", "update", "pad_1", f.folder, "--title", "Renamed"]);
  await run(h, ["pad", "update", "pad_1", f.folder]);
  assert.deepEqual(requests.slice(1).map((r) => r.body.title), ["Renamed", "Renamed"]);
});

test("pad poll --reset discards a stale pending batch instead of replaying it later", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "fresh" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "old", pending: [{ id: "stale", kind: "chat", text: "x" }] }));
  const reset = await run(h, ["pad", "poll", "pad_1", "--once", "--reset"]);
  assert.deepEqual(JSON.parse(reset.stdout), { items: [], cursor: "fresh" });
  const next = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.deepEqual(JSON.parse(next.stdout), { items: [], cursor: "fresh" });
  assert.deepEqual(requests.map((r) => r.query.after), [undefined, "fresh"]);
});

test("pad reply accepts flag-like text after -- and rejects stray positionals elsewhere", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { id: "r2" } }));
  const h = home(t, endpoint);
  const reply = await run(h, ["pad", "reply", "pad_1", "--", "Try", "--help", "or", "--json", "next"]);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(requests[0].body.text, "Try --help or --json next");
  const f = fixtures(t);
  const extra = await run(h, ["pad", "end", "pad_1", "oops"]);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /usage: pad end <padId>/);
  const extraUpdate = await run(h, ["pad", "update", "pad_1", f.single, "stray"]);
  assert.equal(extraUpdate.status, 2);
  assert.equal(requests.length, 1, "no mutation is sent for a malformed invocation");
});

test("pad open rejects unknown flags before launching anything", async (t) => {
  const r = await run(mkdtempSync(join(tmpdir(), "inc-pad-open-")), ["pad", "open", "https://example.com", "--privte", "true"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --privte/);
});

test("mutations refuse to report success on a 2xx that does not confirm the result", async (t) => {
  const { endpoint } = await mockServer(t, () => ({ json: {} }));
  const h = home(t, endpoint);
  const end = await run(h, ["pad", "end", "pad_1"]);
  assert.equal(end.status, 3);
  assert.match(end.stderr, /did not confirm ended/);
  assert.equal(end.stdout, "");
  const reply = await run(h, ["pad", "reply", "pad_1", "hi"]);
  assert.equal(reply.status, 3);
  assert.match(reply.stderr, /no reply id/);
});
