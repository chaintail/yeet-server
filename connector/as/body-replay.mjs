// Lets the sign-in server look at (and adjust) a request body before oidc-provider reads it, without leaving an
// already-parsed body behind. oidc-provider reads the raw stream itself (lib/shared/selective_body.js) and warns
// when an upstream parser consumed it, so this reads the bytes, hands a parsed copy to `inspect`, and puts the
// (possibly rewritten) bytes back as a fresh stream with a matching Content-Length.
//
// inspect(parsed) returns { reject: { status, body } } to answer the request here, or { body } to replace it.
// A body of another content type passes through untouched; the provider answers it as it always does.
import { Readable } from "node:stream";

const KINDS = {
  json: {
    type: /^application\/json\b/i,
    parse: (text) => JSON.parse(text),
    serialize: (value) => JSON.stringify(value),
  },
  form: {
    type: /^application\/x-www-form-urlencoded\b/i,
    // Repeated keys keep every value (the provider rejects repeated OAuth parameters itself).
    parse: (text) => {
      const out = {};
      for (const [k, v] of new URLSearchParams(text)) {
        if (Object.hasOwn(out, k)) out[k] = [].concat(out[k], v);
        else out[k] = v;
      }
      return out;
    },
    serialize: (value) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(value))
        for (const one of [].concat(v)) if (one !== undefined) p.append(k, String(one));
      return p.toString();
    },
  },
};

async function readAll(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function replayBody(req, bytes) {
  const stream = Readable.from(bytes.length ? [bytes] : []);
  req.headers["content-length"] = String(bytes.length);
  delete req.headers["transfer-encoding"];
  Object.defineProperty(req, "readable", { configurable: true, get: () => stream.readable });
  req.iterator = (options) => stream.iterator(options);
  req[Symbol.asyncIterator] = () => stream[Symbol.asyncIterator]();
}

export function inspectBody(kind, inspect, { limit = 32 * 1024 } = {}) {
  const k = KINDS[kind];
  if (!k) throw TypeError(`unknown body kind ${kind}`);
  return async (req, res, next) => {
    if (!k.type.test(req.headers["content-type"] || "")) return next();
    try {
      const bytes = await readAll(req, limit);
      if (bytes === null) return res.status(413).set("Cache-Control", "no-store").json({ error: "invalid_request", error_description: "request body too large" });
      let parsed;
      try {
        parsed = k.parse(bytes.toString("utf8"));
      } catch {
        return res.status(400).set("Cache-Control", "no-store").json({ error: "invalid_request", error_description: "failed to parse the request body" });
      }
      const out = await inspect(parsed);
      if (out?.reject) return res.status(out.reject.status).set("Cache-Control", "no-store").json(out.reject.body);
      replayBody(req, out && "body" in out ? Buffer.from(k.serialize(out.body)) : bytes);
      next();
    } catch (e) {
      next(e);
    }
  };
}
