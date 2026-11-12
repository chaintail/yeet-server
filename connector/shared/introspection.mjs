import {allScopes} from '#scope-catalog';
import { request } from "node:http";
import { AS, AS_INTERNAL, RESOURCE, secret } from "./common.mjs";
// One absolute deadline covers connect, headers and the full body: a trickling AS cannot extend it
// (ClientRequest.setTimeout only measures inactivity). Exported for the deadline regression.
export const INTROSPECTION_DEADLINE_MS = 2000;
export function postIntrospection(url, headers, body, deadlineMs = INTROSPECTION_DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    let q;
    const timer = setTimeout(() => {
      settle(reject, Error("Introspection timeout"));
    }, deadlineMs);
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
      if (fn === reject) q?.destroy();
    };
    try {
      q = request(url, { method: "POST", headers }, (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("error", (e) => settle(reject, e));
        r.on("data", (chunk) => {
          data += chunk;
          if (Buffer.byteLength(data, "utf8") > 32768)
            settle(reject, Error("Introspection response too large"));
        });
        r.on("end", () => {
          try {
            if (r.statusCode !== 200) throw Error("Introspection denied");
            settle(resolve, JSON.parse(data));
          } catch (e) {
            settle(reject, e);
          }
        });
      });
    } catch (e) {
      settle(reject, e);
      return;
    }
    q.on("error", (e) => settle(reject, e));
    q.end(body);
  });
}
// Fixed configured destination, canonical Host, bounded response, no cache or proxy IP trust.
export async function introspectBearer(bearer, client, credential) {
  if (typeof bearer !== "string" || !bearer || bearer.length > 8192)
    throw Error("Missing delegated bearer");
  const body = new URLSearchParams({ token: bearer }).toString();
  return postIntrospection(new URL(`${AS_INTERNAL}/token/introspection`), {
    host: new URL(AS).host,
    authorization:
      "Basic " +
      Buffer.from(`${client}:${secret(credential)}`).toString("base64"),
    "content-type": "application/x-www-form-urlencoded",
    "content-length": Buffer.byteLength(body),
  }, body);
}
export const SUBJECT = /^yeet-privy-[a-zA-Z0-9_-]{1,80}$/;
export function validatePrincipal(token) {
  if (
    token?.active !== true ||
    token.iss !== AS ||
    token.aud !== RESOURCE ||
    !Number.isFinite(token.exp) ||
    token.exp <= Date.now() / 1000 ||
    typeof token.sub !== "string" ||
    !SUBJECT.test(token.sub) ||
    typeof token.client_id !== "string" ||
    !token.client_id ||
    token.client_id.length > 2048 ||
    typeof token.scope !== "string"
  )
    throw Error("Invalid delegated principal");
  return {
    subject: token.sub,
    client: token.client_id,
    scopes: new Set(token.scope.split(" ").filter(s => allScopes.includes(s))),
  };
}
