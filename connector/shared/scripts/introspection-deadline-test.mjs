import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { postIntrospection, INTROSPECTION_DEADLINE_MS } from "#shared/introspection.mjs";

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve(server));
});

test("r8 M1: a trickling AS response fails at the absolute 2 s deadline, not on inactivity", async () => {
  assert.equal(INTROSPECTION_DEADLINE_MS, 2000);
  const timers = new Set();let closed = false;
  const server = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    const t = setInterval(() => res.write(" "), 500);timers.add(t);
    res.on("close", () => { closed = true; clearInterval(t); });
  });
  try {
    const started = performance.now();
    await assert.rejects(
      postIntrospection(new URL(`http://127.0.0.1:${server.address().port}/token/introspection`), { "content-type": "application/x-www-form-urlencoded" }, "token=x"),
      /Introspection timeout/,
    );
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1900 && elapsed < 2600, `elapsed ${elapsed}`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closed, true, "request transport destroyed");
  } finally {
    for (const t of timers) clearInterval(t);
    server.closeAllConnections();server.close();
  }
});

test("r8 M1: a prompt AS response resolves and keeps the 32 KiB cap", async () => {
  const server = await listen((req, res) => {
    req.resume();
    if (req.url === "/big") { res.writeHead(200); res.end("x".repeat(40000)); return; }
    res.writeHead(200, { "content-type": "application/json" });res.end('{"active":true}');
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await postIntrospection(new URL(`${base}/ok`), {}, "token=x"), { active: true });
    await assert.rejects(postIntrospection(new URL(`${base}/big`), {}, "token=x"), /too large/);
  } finally {
    server.closeAllConnections();server.close();
  }
});

test("introspection: a 4xx answer means not active; 429, 5xx, other codes and timeouts stay errors", async () => {
  const server = await listen((req, res) => {
    req.resume();
    const status = Number(req.url.slice(1));
    if (status === 0) return; // never answers
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 400 ? '{"error":"invalid_request"}' : status === 401 ? "not json" : "{}");
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const s of [400, 401, 403, 404]) assert.deepEqual(await postIntrospection(new URL(`${base}/${s}`), {}, "token=x"), { active: false }, String(s));
    for (const s of [429, 500, 502, 503, 302]) await assert.rejects(postIntrospection(new URL(`${base}/${s}`), {}, "token=x"), /Introspection denied/, String(s));
    await assert.rejects(postIntrospection(new URL(`${base}/0`), {}, "token=x", 200), /Introspection timeout/);
  } finally {
    server.closeAllConnections();server.close();
  }
});
