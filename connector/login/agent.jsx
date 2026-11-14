// The agent approval page (https://mcp.yeet.win/approve, as/agent-page.mjs; the rules are in agent-approve.js). The person signs
// in with the YEET sign-in methods (choose-method.jsx, the same Privy configuration as every other page: nothing is
// created here), sees the code their agent printed, and presses Approve or Deny. Under it, "Agents with access":
// every agent this Privy user approved, each with Revoke. Every call goes to Privy with the person's own token.
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { privyConfig } from "./privy-app.jsx";
import { ChooseMethod, useEnabledMethods } from "./choose-method.jsx";
import { NO_METHOD_LINE } from "./login-methods.js";
import { words } from "./brand-words.jsx";
import { Swap } from "./screen.jsx";
import { AGENT_PATH, APPROVE_LINE, LINES, agentView, deviceVerify, forgetCode, grantLine, keepCode, listGrants, normalCode, revokeGrant, startCode } from "./agent-approve.js";

const storage = (() => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
})();

function Grants({ appId, getAccessToken, onSignedOut, reload }) {
  const [state, setState] = useState({ status: "loading", grants: [] });
  const [revoking, setRevoking] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    const token = await getAccessToken().catch(() => null);
    const out = await listGrants({ appId, token });
    if (out.status === "signin") return onSignedOut();
    setState(out.status === "ok" ? out : { status: "error", grants: [] });
  }, [appId, getAccessToken, onSignedOut]);
  useEffect(() => {
    load();
  }, [load, reload]);
  async function revoke(id) {
    setRevoking(id);
    setNote("");
    const token = await getAccessToken().catch(() => null);
    const out = await revokeGrant({ appId, token, id });
    setRevoking("");
    if (out.status === "signin") return onSignedOut();
    if (out.status !== "ok") return setNote(LINES.revokeError);
    setNote("Revoked. That agent can’t refresh its access any more; a key it already holds stops working within 15 minutes.");
    load();
  }
  return (
    <>
      <h2 className="section">Agents with access</h2>
      {state.status === "loading" ? (
        <p role="status">Loading…</p>
      ) : state.status === "error" ? (
        <>
          <p role="alert" className="notice">{LINES.grantsError}</p>
          <button type="button" className="secondary" onClick={load}>
            Try again
          </button>
        </>
      ) : !state.grants.length ? (
        <p className="hint">{words(LINES.none)}</p>
      ) : (
        state.grants.map((g) => (
          <div className="row" key={g.id}>
            <span className="address">{grantLine(g)}</span>
            <button type="button" className="secondary" disabled={!!revoking} onClick={() => revoke(g.id)}>
              {revoking === g.id ? "Revoking…" : "Revoke"}
            </button>
          </div>
        ))
      )}
      <p role="status">{note}</p>
    </>
  );
}

function Approve({ appId, methods: offered }) {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const methods = useEnabledMethods(offered);
  const [code, setCode] = useState(() => startCode({ search: location.search, storage }));
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const signedOut = useCallback(async () => {
    setNotice(LINES.signin);
    setResult(null);
    try {
      await logout();
    } catch {
      /* the sign-in methods show anyway */
    }
  }, [logout]);
  const screen = agentView({ ready, authenticated, code, result });

  async function press(action) {
    setBusy(true);
    setNotice("");
    const token = await getAccessToken().catch(() => null);
    const out = await deviceVerify({ appId, token, userCode: code, action });
    setBusy(false);
    if (out.status === "signin") return signedOut();
    // A code is used once: approved, denied or expired, it is never offered again from this tab.
    if (out.status !== "error") forgetCode(storage);
    setResult(out.status);
    if (out.status === "approved") setReload((n) => n + 1);
  }
  function takeTyped() {
    const c = normalCode(typed);
    if (!c) return setTypedError(LINES.invalid);
    setTypedError("");
    keepCode(storage, c);
    setCode(c);
  }
  function another() {
    forgetCode(storage);
    setCode("");
    setTyped("");
    setResult(null);
  }

  return (
    <>
      <Swap id={screen === "signin" && methods === null ? "loading" : screen}>
        {screen === "loading" || (screen === "signin" && methods === null) ? (
          <p role="status">One moment…</p>
        ) : screen === "signin" ? (
          !methods.length ? (
            <p role="status">{words(NO_METHOD_LINE)}</p>
          ) : (
            <>
              {code ? (
                <>
                  <p className="label">Code from your agent</p>
                  <p className="address">{code}</p>
                </>
              ) : null}
              <ChooseMethod
                methods={methods}
                signup={false}
                intro="Sign in to YEET to approve or deny the agent."
                verifyLabel="Confirm"
                pageNotice={notice}
              />
            </>
          )
        ) : screen === "nocode" ? (
          <>
            <p className="lead">{words(LINES.nocode)}</p>
            <label htmlFor="agent-code">Code from your agent</label>
            <input
              id="agent-code"
              className="code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={25}
              value={typed}
              aria-invalid={typedError ? "true" : undefined}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                takeTyped();
              }}
            />
            <button type="button" onClick={takeTyped}>
              Continue
            </button>
            <p role="alert" className={typedError ? "notice" : undefined}>
              {typedError}
            </p>
          </>
        ) : screen === "confirm" ? (
          <>
            <p className="label">Code from your agent</p>
            <p className="address">{code}</p>
            <p className="hint">Check that this is the code your agent shows right now.</p>
            <p className="limit">{words(APPROVE_LINE)}</p>
            <button type="button" disabled={busy} onClick={() => press("approve")}>
              {busy ? "One moment…" : "Approve"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => press("deny")}>
              Deny
            </button>
            <p role="alert" className={notice ? "notice" : undefined}>
              {notice}
            </p>
          </>
        ) : screen === "approved" ? (
          <p role="status" className="lead">
            {words(LINES.approved)}
          </p>
        ) : screen === "denied" ? (
          <>
            <p role="status" className="lead">
              {words(LINES.denied)}
            </p>
            <button type="button" className="secondary" onClick={another}>
              Enter another code
            </button>
          </>
        ) : screen === "expired" ? (
          <>
            <p role="alert" className="notice">
              {LINES.expired}
            </p>
            <button type="button" className="secondary" onClick={another}>
              Enter another code
            </button>
          </>
        ) : (
          <>
            <p role="alert" className="notice">
              {words(LINES.error)}
            </p>
            <button type="button" onClick={() => setResult(null)}>
              Try again
            </button>
          </>
        )}
      </Swap>
      {ready && authenticated ? <Grants appId={appId} getAccessToken={getAccessToken} onSignedOut={signedOut} reload={reload} /> : null}
    </>
  );
}

const root = document.getElementById("yeet-agent");
try {
  const response = await fetch("/account/identity-config", { credentials: "same-origin" });
  if (!response.ok) throw Error();
  const config = await response.json();
  createRoot(root).render(
    // Google and Apple return to the bare page address (https://mcp.yeet.win/approve on the agent host): Privy's allowed
    // redirect list matches exactly, with no query.
    <PrivyProvider appId={config.appId} config={{ ...privyConfig(), customOAuthRedirectUrl: `${location.origin}${AGENT_PATH}` }}>
      <Approve appId={config.appId} methods={Array.isArray(config.methods) ? config.methods : undefined} />
    </PrivyProvider>,
  );
} catch {
  const line = document.createElement("p");
  line.className = "notice";
  line.setAttribute("role", "alert");
  line.textContent = "Agent approval is unavailable right now. Please try again later.";
  root.replaceChildren(line);
}
