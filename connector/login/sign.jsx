// The sign-in step of the trade page (as/sign-page.mjs, as/viewer/sign/sign.js): the methods the page names
// (Continue with Google, Continue with Apple when it is on; email with a code only when offered), from the same component
// (choose-method.jsx) and the same Privy configuration (privy-app.jsx). The page loads this bundle only when the
// browser has no YEET session, or when Google or Apple is sending the person back.
//
// Differences from the connect screen, all on purpose:
//   - nothing is ever created here (signup off): only the account that made the trade can finish it;
//   - Google and Apple return to the bare page address (customOAuthRedirectUrl = <origin>/sign, no query): Privy's
//     allowed OAuth redirect URLs must match exactly, with no query
//     (https://docs.privy.io/recipes/react/allowed-oauth-redirects). The page keeps the trade id for the way back
//     (sign.js) and picks the trade up again by itself;
//   - when the session exists the page reloads itself: the wallet runs on the page's own Privy client (the vendored
//     yeet-signer.js), which reads the same session from this origin's storage. One client at a time.
//
// mountSignIn(element, {appId, redirectUrl, intro, methods, onStart, onDone}) -> unmount()
//   methods: the ids the page offers (the trade page's data-methods: YEET_LOGIN_METHODS, or the trade's own account's
//   methods when the card's link carried them); with none given, Google and Apple.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useLoginWithOAuth } from "@privy-io/react-auth";
import { privyConfig } from "./privy-app.jsx";
import { NO_METHOD_LINE, oauthRefusal } from "./login-methods.js";
import { ChooseMethod, useEnabledMethods } from "./choose-method.jsx";
import { words } from "./brand-words.jsx";
import { Swap } from "./screen.jsx";

function Step({ intro, methods: offered, onStart, onDone }) {
  const { ready, authenticated } = usePrivy();
  const methods = useEnabledMethods(offered);
  // A Google or Apple return that was refused (the account must already exist here): read from the flow's own state,
  // so it is known whenever the methods appear, and only an OAuth refusal is ever shown this way.
  const { loading, state } = useLoginWithOAuth();
  const refusal = state?.status === "error" ? oauthRefusal(state.error?.privyErrorCode) : "";
  const [seen, setSeen] = useState(false);
  const told = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || told.current) return;
    told.current = true;
    onDone();
  }, [ready, authenticated, onDone]);
  const screen = !ready ? "loading" : authenticated ? "done" : methods === null ? "loading" : !methods.length ? "none" : "methods";
  return (
    <Swap id={screen}>
      {screen === "loading" ? (
        <p role="status">One moment…</p>
      ) : screen === "done" ? (
        <p role="status">That’s you. Getting your trade…</p>
      ) : screen === "none" ? (
        <p role="status">{words(NO_METHOD_LINE)}</p>
      ) : (
        <>
          {loading ? <p role="status">Checking that it’s you…</p> : null}
          <ChooseMethod
            methods={methods}
            signup={false}
            intro={intro}
            verifyLabel="Confirm"
            pageNotice={loading || seen ? "" : refusal}
            onStart={() => {
              setSeen(true);
              onStart?.();
            }}
          />
        </>
      )}
    </Swap>
  );
}

export function mountSignIn(element, { appId, redirectUrl, intro, methods, onStart, onDone }) {
  const root = createRoot(element);
  root.render(
    <PrivyProvider appId={appId} config={{ ...privyConfig(), ...(redirectUrl ? { customOAuthRedirectUrl: redirectUrl } : {}) }}>
      <Step intro={intro} methods={methods} onStart={onStart} onDone={onDone} />
    </PrivyProvider>,
  );
  return () => root.unmount();
}
