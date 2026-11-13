// QR generator: Reed-Solomon against the ISO/IEC 18004 worked example, and whole matrices against reference vectors
// (made with the qrcode package 1.5.4, byte mode, level M, which picks masks by the same penalty rules).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { qrCode, qrPath, reedSolomon, QR_MAX_VERSION } from "./qr.js";

const rows = (c) => c.rows.map((r) => r.join("")).join("\n");
const sha = (c) => createHash("sha256").update(rows(c)).digest("hex");

test("Reed-Solomon: 1-M example (data for 01234567) gives the published error correction codewords", () => {
  assert.deepEqual(
    reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10),
    [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
  );
});

test("version 1-M, mask 4: the whole matrix for HELLO WORLD in byte mode", () => {
  const c = qrCode("HELLO WORLD");
  assert.deepEqual([c.version, c.mask, c.size], [1, 4, 21]);
  assert.equal(
    rows(c),
    [
      "111111101100101111111",
      "100000100001001000001",
      "101110100101001011101",
      "101110101001001011101",
      "101110101110101011101",
      "100000101001001000001",
      "111111101010101111111",
      "000000001001100000000",
      "100010111111011111001",
      "000100001011100001111",
      "001111110011011010010",
      "111110001100010000000",
      "111110101010101100110",
      "000000001010111101011",
      "111111101110101011010",
      "100000100101110110011",
      "101110101101011000110",
      "101110100100100011011",
      "101110100111000111000",
      "100000100001010000000",
      "111111101111111110101",
    ].join("\n"),
  );
});

test("reference vectors: wallet addresses, the USDC mint, version 8 and the largest version (10, with version info)", () => {
  for (const [text, version, mask, hash] of [
    ["0x5a1C0ffee0D15ea5e0000000000000000000B45E", 3, 2, "156e2a97218c6d91f9744448b4e297d97c50f8e7b86afaf53fd519d0ef421f34"],
    ["7YeetSo1anaWa11etAddre55xxxxxxxxxxxxxxxxx", 3, 0, "0bd987ce2560205938bc0971ffd348aaa1f98842b9c7e39ca397ac62b1517a0b"],
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 4, 2, "656c51de5a76d4266336eec2bbbc512ccec6140c3cec966139f436a7131612b2"],
    ["x".repeat(150), 8, 2, "9782fa7f0642d3e6b22295c01fc9e2fe9a0f19d22af2cf7b3964dcb6a932e44e"],
    ["y".repeat(213), 10, 1, "3bb4dc258df63cd72866923bcf69b2a163f017bd6dd5d9d77a92f7f81ad9c892"],
  ]) {
    const c = qrCode(text);
    assert.deepEqual([c.version, c.mask, c.size], [version, mask, 17 + 4 * version], text.slice(0, 20));
    assert.equal(sha(c), hash, text.slice(0, 20));
  }
});

test("matches the qrcode package module for module when it is installed (any input length, UTF-8)", (t) => {
  let QR;
  try {
    QR = createRequire(import.meta.url)("qrcode");
  } catch {
    return t.skip("qrcode package not installed");
  }
  const inputs = ["a", "héllo ⚡", "solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=10.5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];
  for (let n = 1; n <= 213; n += 11) inputs.push("q".repeat(n));
  for (const text of inputs) {
    const ref = QR.create([{ data: Buffer.from(text, "utf8"), mode: "byte" }], { errorCorrectionLevel: "M" });
    const c = qrCode(text);
    const want = [];
    for (let y = 0; y < ref.modules.size; y++) want.push(Array.from(ref.modules.data.slice(y * ref.modules.size, (y + 1) * ref.modules.size)).join(""));
    assert.equal(c.version, ref.version, text);
    assert.equal(c.mask, ref.maskPattern, text);
    assert.equal(rows(c), want.join("\n"), text);
  }
});

test("limits and SVG path", () => {
  assert.equal(QR_MAX_VERSION, 10);
  assert.throws(() => qrCode("z".repeat(214)), /qr-too-long/);
  assert.throws(() => qrCode(""), /qr-empty/);
  assert.throws(() => qrCode(null), /qr-empty/);
  const c = qrCode("HELLO WORLD");
  const d = qrPath(c, 4);
  // First row 111111101100101111111: finder (x 0..6), 2 at x 8..9, 1 at x 12, finder (x 14..20); quiet zone adds 4.
  assert.ok(d.startsWith("M4 4h7v1h-7zM12 4h2v1h-2zM16 4h1v1h-1zM18 4h7v1h-7z"), d.slice(0, 80));
  const dark = c.rows.flat().reduce((a, b) => a + b, 0);
  const drawn = [...d.matchAll(/h(\d+)v1/g)].reduce((a, m) => a + Number(m[1]), 0);
  assert.equal(drawn, dark);
});
