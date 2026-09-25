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
        agent: req.headers["x-incpad-agent"],
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
function run(homeDir, args, env = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, INCUBATOR_HOME: homeDir, ...env } });
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
  assert.equal(typeof req.agent, "string");
  assert.ok(req.agent.length > 0);
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

test("pad ack confirms the last polled batch with a working note and agent name", async (t) => {
  const items = [{ id: "f1", kind: "comment", text: "Larger" }, { id: "f2", kind: "chat", text: "Why?" }];
  const { requests, endpoint } = await mockServer(t, (req) =>
    req.path.endsWith("/feedback") ? { json: { items, cursor: "c2" } } : { json: { acked: ["f1", "f2"] } },
  );
  const h = home(t, endpoint);
  const env = { INC_PAD_AGENT: "Claude Code" };
  const poll = await run(h, ["pad", "poll", "pad_1", "--once"], env);
  assert.equal(poll.status, 0, poll.stderr);
  const ack = await run(h, ["pad", "ack", "pad_1", "--note", "Making the heading larger."], env);
  assert.equal(ack.status, 0, ack.stderr);
  assert.deepEqual(JSON.parse(ack.stdout), { acked: ["f1", "f2"] });
  assert.deepEqual(requests.map((req) => req.agent), ["Claude Code", "Claude Code"]);
  assert.equal(requests[1].path, "/api/v1/pads/pad_1/ack");
  assert.deepEqual(requests[1].body, { item_ids: ["f1", "f2"], note: "Making the heading larger." });
  const state = JSON.parse(readFileSync(join(h, "pads", "pad_1.json"), "utf8"));
  assert.equal(state.cursor, "c2");
  assert.deepEqual(state.last_batch_ids, ["f1", "f2"]);
});

test("pad ack can target explicit items and refuses an empty or malformed batch", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { acked: ["f3"] } }));
  const h = home(t, endpoint);
  const noBatch = await run(h, ["pad", "ack", "pad_1"]);
  assert.equal(noBatch.status, 2);
  assert.match(noBatch.stderr, /poll first or pass --items/);
  for (const args of [
    ["--items", "f1,,f2"],
    ["--items", "f1,f1"],
    ["--items", "f1", "--note", "x".repeat(201)],
  ]) {
    const bad = await run(h, ["pad", "ack", "pad_1", ...args]);
    assert.equal(bad.status, 2, bad.stderr);
  }
  assert.equal(requests.length, 0, "invalid acks never reach the server");
  const explicit = await run(h, ["pad", "ack", "pad_1", "--items", " f3 "]);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(requests[0].body, { item_ids: ["f3"] });
});

test("an empty poll clears the default ack target but explicit IDs remain available", async (t) => {
  let polled = false;
  const { requests, endpoint } = await mockServer(t, (req) => {
    if (req.path.endsWith("/ack")) return { json: { acked: ["f1"] } };
    if (!polled) {
      polled = true;
      return { json: { items: [{ id: "f1", text: "Change" }], cursor: "c1" } };
    }
    return { json: { items: [], cursor: "c1" } };
  });
  const h = home(t, endpoint);
  await run(h, ["pad", "poll", "pad_1", "--once"]);
  await run(h, ["pad", "poll", "pad_1", "--once"]);
  const stale = await run(h, ["pad", "ack", "pad_1"]);
  assert.equal(stale.status, 2);
  assert.equal(requests.filter((req) => req.path.endsWith("/ack")).length, 0);
  const explicit = await run(h, ["pad", "ack", "pad_1", "--items", "f1"]);
  assert.equal(explicit.status, 0, explicit.stderr);
});

test("pad ack uses a replayed batch and does not accept an unconfirmed response", async (t) => {
  const { requests, endpoint } = await mockServer(t, (req) =>
    req.path.endsWith("/ack") ? { json: {} } : { json: { items: [], cursor: "c7" } },
  );
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c7", pending: [{ id: "f9", text: "Update" }] }));
  const replay = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  const ack = await run(h, ["pad", "ack", "pad_1"]);
  assert.equal(ack.status, 3);
  assert.match(ack.stderr, /did not confirm every requested item/);
  assert.equal(ack.stdout, "");
  assert.deepEqual(requests[0].body, { item_ids: ["f9"] });
});

test("pad ack rejects partial confirmation", async (t) => {
  const { endpoint } = await mockServer(t, () => ({ json: { acked: ["f1"] } }));
  const h = home(t, endpoint);
  const ack = await run(h, ["pad", "ack", "pad_1", "--items", "f1,f2"]);
  assert.equal(ack.status, 3);
  assert.match(ack.stderr, /did not confirm every requested item/);
  assert.equal(ack.stdout, "");
});

test("pad ack prefers a newer batch pending replay over older delivered IDs", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { acked: ["new"] } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({
    cursor: "c2", last_batch_ids: ["old"], pending: [{ id: "new", text: "Update" }],
  }));
  const ack = await run(h, ["pad", "ack", "pad_1"]);
  assert.equal(ack.status, 0, ack.stderr);
  assert.deepEqual(requests[0].body, { item_ids: ["new"] });
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
  const env = { INC_PAD_AGENT: "Claude Code" };
  const reply = await run(h, ["pad", "reply", "pad_1", "Made", "the", "heading", "bigger"], env);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stdout, "replyId: r1\n");
  assert.deepEqual(requests[0], {
    method: "POST",
    path: "/api/v1/pads/pad_1/replies",
    query: {},
    auth: "Bearer org_key_123",
    agent: "Claude Code",
    body: { text: "Made the heading bigger" },
  });
  const end = await run(h, ["pad", "end", "pad_1"], env);
  assert.equal(end.status, 0, end.stderr);
  assert.equal(end.stdout, "ended: true\n");
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].path, "/api/v1/pads/pad_1/end");
  assert.equal(requests[1].agent, "Claude Code");
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
  for (const bad of ["{not json", "[]", "false", "\"old\"", JSON.stringify({ cursor: 7 }), JSON.stringify({ pending: "x" })]) {
    writeFileSync(join(h, "pads", "pad_1.json"), bad);
    const r = await run(h, ["pad", "poll", "pad_1", "--once"]);
    assert.equal(r.status, 4, `state ${bad} should be rejected`);
    assert.match(r.stderr, /corrupt/);
  }
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

test("a 2xx whose body stalls or is not JSON is a failed request, not an empty poll", async (t) => {
  const stalled = createRawServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{\"items\": [");
  });
  await new Promise((r) => stalled.listen(0, "127.0.0.1", r));
  t.after(() => stalled.closeAllConnections?.() ?? stalled.close());
  const stall = await run(home(t, `http://127.0.0.1:${stalled.address().port}`), ["pad", "poll", "pad_1", "--once", "--timeout", "1"]);
  assert.equal(stall.status, 3);
  assert.match(stall.stderr, /timed out reading the response body/);
  assert.equal(stall.stdout, "", "no empty batch is printed for a failed poll");

  const garbled = createRawServer((req, res) => {
    res.writeHead(req.url.endsWith("/feedback") ? 200 : 502, { "content-type": "text/html" });
    res.end("<html>upstream</html>");
  });
  await new Promise((r) => garbled.listen(0, "127.0.0.1", r));
  t.after(() => garbled.close());
  const h = home(t, `http://127.0.0.1:${garbled.address().port}`);
  const okNotJson = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(okNotJson.status, 3);
  assert.match(okNotJson.stderr, /returned 200 with a body that is not JSON/);
  assert.equal(okNotJson.stdout, "");
  const errNotJson = await run(h, ["pad", "end", "pad_1"]);
  assert.equal(errNotJson.status, 1);
  assert.match(errNotJson.stderr, /failed \(502\)/, "an error status still reports its code when the body is not JSON");
});

test("pad create rejects a directory whose index.html is a symlink or a directory", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const h = home(t, endpoint);
  const f = fixtures(t);
  const linked = join(f.dir, "linked");
  mkdirSync(linked);
  symlinkSync(f.single, join(linked, "index.html"));
  const viaLink = await run(h, ["pad", "create", linked]);
  assert.notEqual(viaLink.status, 0);
  assert.match(viaLink.stderr, /index\.html is a symlink/);
  const nested = join(f.dir, "nested");
  mkdirSync(join(nested, "index.html"), { recursive: true });
  const viaDir = await run(h, ["pad", "create", nested]);
  assert.notEqual(viaDir.status, 0);
  assert.match(viaDir.stderr, /index\.html is a directory/);
  assert.equal(requests.length, 0, "nothing is uploaded when the entry would be missing from the payload");
});

test("a replayed batch keeps the ended flag saved with it", async (t) => {
  const pending = [{ id: "f10", kind: "comment", text: "Last word", selector: "h1", selected_text: "Hi", created_at: "2026-09-25T00:00:00Z" }];
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c8" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c8", pending, pending_ended: true, ended: true }));
  const replay = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout), { items: pending, cursor: "c8", ended: true, replayed: true });
  assert.equal(requests.length, 0);
});

test("retired plan flags still reach the IncPad migration message", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: {} }));
  const r = await run(home(t, endpoint), ["plan", "share", "x", "--rotate", "--expect", "y"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /moved to IncPad/);
  assert.doesNotMatch(r.stderr, /--rotate requires a value/);
  assert.equal(requests.length, 0);
});

test("pad poll rejects a zero or negative --interval but allows --timeout 0", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c0" } }));
  const h = home(t, endpoint);
  for (const interval of ["0", "-0", "-5"]) {
    const r = await run(h, ["pad", "poll", "pad_1", "--interval", interval]);
    assert.equal(r.status, 2, `--interval ${interval}: ${r.stderr}`);
    assert.match(r.stderr, /--interval must be a positive number of seconds/);
  }
  assert.equal(requests.length, 0, "a rejected interval never reaches the server");
  const zeroTimeout = await run(h, ["pad", "poll", "pad_1", "--timeout", "0"]);
  assert.equal(zeroTimeout.status, 0, zeroTimeout.stderr);
  assert.deepEqual(JSON.parse(zeroTimeout.stdout), { items: [], cursor: "c0" });
  assert.equal(requests.length, 1, "--timeout 0 still performs one immediate check");
});

test("the first poll sends a bare /feedback path with no stray query marker", async (t) => {
  const seen = [];
  const raw = createRawServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [], cursor: "c1" }));
  });
  await new Promise((r) => raw.listen(0, "127.0.0.1", r));
  t.after(() => raw.close());
  const r = await run(home(t, `http://127.0.0.1:${raw.address().port}`), ["pad", "poll", "pad_1", "--once"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(seen, ["/api/v1/pads/pad_1/feedback"]);
});

test("pad create refuses a symlinked root so a link cannot pull in another directory", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const f = fixtures(t);
  const link = join(f.dir, "linked-site");
  symlinkSync(f.folder, link);
  const r = await run(home(t, endpoint), ["pad", "create", link]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is a symlink - pass the real path/);
  assert.equal(requests.length, 0);
});

test("an ended review with no items is replayed if its delivery was interrupted", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c9" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c9", pending: [], pending_ended: true, ended: true }));
  const replay = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout), { items: [], cursor: "c9", ended: true, replayed: true });
  assert.equal(requests.length, 0);
  const again = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.deepEqual(JSON.parse(again.stdout), { items: [], cursor: "c9" });
  assert.equal(requests.length, 1, "after delivery the terminal batch is not replayed again");
});

test("a malformed feedback batch fails without advancing the saved cursor", async (t) => {
  const { endpoint } = await mockServer(t, () => ({ json: { items: "nope", cursor: "advanced" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c1" }));
  const r = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no items array/);
  assert.equal(JSON.parse(readFileSync(join(h, "pads", "pad_1.json"), "utf8")).cursor, "c1");
});

test("feedback items need distinct string IDs before the cursor is saved", async (t) => {
  for (const items of [[{ text: "Missing" }], [{ id: "" }], [{ id: "same" }, { id: "same" }]]) {
    const { endpoint } = await mockServer(t, () => ({ json: { items, cursor: "advanced" } }));
    const h = home(t, endpoint);
    mkdirSync(join(h, "pads"), { recursive: true });
    writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c1" }));
    const poll = await run(h, ["pad", "poll", "pad_1", "--once"]);
    assert.equal(poll.status, 3);
    assert.match(poll.stderr, /invalid item ids/);
    assert.equal(JSON.parse(readFileSync(join(h, "pads", "pad_1.json"), "utf8")).cursor, "c1");
  }
});

test("a malformed pending batch is rejected before replay can corrupt local state", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: "c1" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c1", pending: [{ text: "No ID" }] }));
  const replay = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(replay.status, 4);
  assert.match(replay.stderr, /state .* is corrupt/);
  assert.equal(replay.stdout, "");
  assert.equal(requests.length, 0);
});

test("a literal backslash in a POSIX file name is read as-is and uploaded under its real name", { skip: process.platform === "win32" }, async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: created }));
  const f = fixtures(t);
  writeFileSync(join(f.folder, "odd\\name.txt"), "literal backslash");
  const r = await run(home(t, endpoint), ["pad", "create", f.folder, "--title", "Site"]);
  assert.equal(r.status, 0, r.stderr);
  const odd = requests[0].body.files.find((x) => x.path === "odd\\name.txt");
  assert.equal(Buffer.from(odd.content_base64, "base64").toString(), "literal backslash");
});

test("pad poll --timeout 0 still performs one immediate check", async (t) => {
  const items = [{ id: "f1", kind: "chat", text: "hi", selector: null, selected_text: null, created_at: "2026-09-25T00:00:00Z" }];
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items, cursor: "c1" } }));
  const r = await run(home(t, endpoint), ["pad", "poll", "pad_1", "--timeout", "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { items, cursor: "c1" });
  assert.equal(requests.length, 1);
});

test("a non-string feedback cursor fails without touching the saved state", async (t) => {
  const { endpoint } = await mockServer(t, () => ({ json: { items: [], cursor: 42 } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c1" }));
  const r = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /cursor that is not a string/);
  assert.equal(JSON.parse(readFileSync(join(h, "pads", "pad_1.json"), "utf8")).cursor, "c1");
});

test("corrupt pad state blocks update and end before any request, and never hides a completed create", async (t) => {
  const { requests, endpoint } = await mockServer(t, () => ({ json: { ...created, ended: true, revision: 2 } }));
  const h = home(t, endpoint);
  const f = fixtures(t);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), "[]");
  for (const args of [["pad", "end", "pad_1"], ["pad", "update", "pad_1", f.single, "--title", "T"]]) {
    const r = await run(h, args);
    assert.equal(r.status, 4, args.join(" "));
    assert.match(r.stderr, /corrupt/);
  }
  assert.equal(requests.length, 0, "no mutation is sent when local state is corrupt");
  const create = await run(h, ["pad", "create", f.single]);
  assert.equal(create.status, 4);
  assert.match(create.stdout, /padId: pad_1/, "the server-accepted pad is still reported");
  assert.match(create.stderr, /server accepted the request but local pad state was not saved/);
});

test("a replayed batch after --reset is not marked ended by the pad's historical ended flag", async (t) => {
  const items = [{ id: "h1", kind: "comment", text: "old feedback", selector: "p", selected_text: null, created_at: "2026-09-25T00:00:00Z" }];
  const { requests, endpoint } = await mockServer(t, () => ({ json: { items, cursor: "c1" } }));
  const h = home(t, endpoint);
  mkdirSync(join(h, "pads"), { recursive: true });
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c9", ended: true, pending: [], pending_ended: false }));
  const reset = await run(h, ["pad", "poll", "pad_1", "--once", "--reset"]);
  assert.deepEqual(JSON.parse(reset.stdout), { items, cursor: "c1" }, "a re-fetched nonterminal batch carries no ended flag");
  assert.equal(JSON.parse(readFileSync(join(h, "pads", "pad_1.json"), "utf8")).ended, false, "reset clears the historical ended flag");
  // Simulate an interrupted delivery of that batch: pending saved, historical ended still set.
  writeFileSync(join(h, "pads", "pad_1.json"), JSON.stringify({ cursor: "c1", ended: true, pending: items, pending_ended: false }));
  const replay = await run(h, ["pad", "poll", "pad_1", "--once"]);
  assert.deepEqual(JSON.parse(replay.stdout), { items, cursor: "c1", replayed: true });
  assert.equal(requests.length, 1);
});
