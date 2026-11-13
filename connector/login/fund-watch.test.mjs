// Balance watch with fake timers, a fake document and a scripted balance: first read, rises, errors, hidden tab,
// refresh, stop.
import test from "node:test";
import assert from "node:assert/strict";
import { watchBalance, WATCH_INTERVAL_MS } from "./fund-watch.js";

function fakes(balances) {
  const timers = new Map();
  let nextId = 1;
  const listeners = new Set();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type, f) => type === "visibilitychange" && listeners.add(f),
    removeEventListener: (type, f) => type === "visibilitychange" && listeners.delete(f),
  };
  const updates = [];
  let reads = 0;
  const queue = [...balances];
  const read = async () => {
    reads++;
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  const env = {
    doc,
    updates,
    timers,
    listeners,
    get reads() {
      return reads;
    },
    setTimer: (f, ms) => {
      const id = nextId++;
      timers.set(id, { f, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    /** Fires the one pending timer and lets the read settle. */
    async fire() {
      assert.equal(timers.size, 1, "one timer pending");
      const [[id, t]] = timers;
      timers.delete(id);
      t.f();
      await settle();
    },
    async hide() {
      doc.visibilityState = "hidden";
      for (const f of listeners) f();
      await settle();
    },
    async show() {
      doc.visibilityState = "visible";
      for (const f of listeners) f();
      await settle();
    },
  };
  env.start = async () => {
    const w = watchBalance({ read, onUpdate: (u) => updates.push(u), doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
    await settle();
    return w;
  };
  return env;
}
const settle = () => new Promise((r) => setImmediate(r));

test("first read sets the baseline (nothing arrived), then polls every interval", async () => {
  const f = fakes([42_500_000n]);
  const w = await f.start();
  assert.deepEqual(f.updates, [{ status: "ready", units: 42_500_000n, arrived: 0n }]);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, WATCH_INTERVAL_MS);
  assert.equal(WATCH_INTERVAL_MS, 10_000);
  await f.fire();
  assert.equal(f.reads, 2);
  assert.deepEqual(f.updates.at(-1), { status: "ready", units: 42_500_000n, arrived: 0n });
  w.stop();
});

test("a rise reports exactly the added units once; a fall or the same balance reports nothing arrived", async () => {
  const f = fakes([10_000_000n, 35_000_000n, 35_000_000n, 20_000_000n, 30_500_000n]);
  const w = await f.start();
  for (let i = 0; i < 4; i++) await f.fire();
  assert.deepEqual(
    f.updates.map((u) => u.arrived),
    [0n, 25_000_000n, 0n, 0n, 10_500_000n],
  );
  assert.deepEqual(f.updates.map((u) => u.units), [10_000_000n, 35_000_000n, 35_000_000n, 20_000_000n, 30_500_000n]);
  w.stop();
});

test("a failed read reports an error, keeps the last good balance and keeps polling", async () => {
  const f = fakes([5_000_000n, new Error("rpc down"), 8_000_000n]);
  const w = await f.start();
  await f.fire();
  assert.deepEqual(f.updates.at(-1), { status: "error" });
  assert.equal(f.timers.size, 1, "still polling after an error");
  await f.fire();
  assert.deepEqual(f.updates.at(-1), { status: "ready", units: 8_000_000n, arrived: 3_000_000n });
  w.stop();
});

test("a failed first read is not a baseline: the next good read reports nothing arrived", async () => {
  const f = fakes([new Error("rpc down"), 9_000_000n]);
  const w = await f.start();
  assert.deepEqual(f.updates, [{ status: "error" }]);
  await f.fire();
  assert.deepEqual(f.updates.at(-1), { status: "ready", units: 9_000_000n, arrived: 0n });
  w.stop();
});

test("hidden tab: the timer is cleared and nothing is read; visible again: one read at once, then polling", async () => {
  const f = fakes([1_000_000n, 1_000_000n, 26_000_000n]);
  const w = await f.start();
  await f.hide();
  assert.equal(f.timers.size, 0, "no timer while hidden");
  assert.equal(f.reads, 1);
  await f.show();
  assert.equal(f.reads, 2, "reads when the tab comes back");
  assert.equal(f.timers.size, 1);
  await f.fire();
  assert.deepEqual(f.updates.at(-1), { status: "ready", units: 26_000_000n, arrived: 25_000_000n });
  w.stop();
});

test("starting in a hidden tab reads nothing until it is visible", async () => {
  const f = fakes([3n]);
  f.doc.visibilityState = "hidden";
  const w = await f.start();
  assert.equal(f.reads, 0);
  assert.equal(f.timers.size, 0);
  await f.show();
  assert.equal(f.reads, 1);
  w.stop();
});

test("refresh reads at once and restarts the interval; stop clears the timer and the listener", async () => {
  const f = fakes([1n, 2n]);
  const w = await f.start();
  w.refresh();
  await settle();
  assert.equal(f.reads, 2);
  assert.deepEqual(f.updates.at(-1), { status: "ready", units: 2n, arrived: 1n });
  assert.equal(f.timers.size, 1);
  w.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  w.refresh();
  await settle();
  assert.equal(f.reads, 2, "no reads after stop");
});

test("a read still on its way when stopped or refreshed is dropped", async () => {
  let release;
  const updates = [];
  const timers = new Map();
  const w = watchBalance({
    read: () => new Promise((r) => (release = r)),
    onUpdate: (u) => updates.push(u),
    doc: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    setTimer: (f) => (timers.set(1, f), 1),
    clearTimer: () => timers.clear(),
  });
  const first = release;
  w.refresh();
  const second = release;
  first(100n);
  await settle();
  assert.deepEqual(updates, [], "the dropped read reports nothing");
  second(5n);
  await settle();
  assert.deepEqual(updates, [{ status: "ready", units: 5n, arrived: 0n }]);
  w.stop();
  timers.get(1)?.();
  await settle();
  assert.equal(updates.length, 1);
});
