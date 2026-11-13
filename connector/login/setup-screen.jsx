// The waiting screen while YEET sets up the wallets: the YEET mark charges, the bar fills with running dashes, and
// the step list from wallet-setup.js ticks off (CSS in as/viewer/auth-pages.css; still under prefers-reduced-motion).
// No Privy here, so it renders anywhere.
import React from "react";
import { STEPS } from "./wallet-setup.js";
import { words } from "./brand-words.jsx";

/** How far the bar is along at each step, in percent. */
const FILL = { check: 8, base: 30, solana: 58, link: 84 };

/**
 * step: "base" | "solana" | "link" | "check". done: step ids already finished. slow: the setup has taken longer than
 * usual (shows the notice and onRetry's button).
 */
export function SetupProgress({ step, done = [], slow = false, failed = false, message = "", onRetry }) {
  const active = STEPS.find((s) => s.id === step);
  const complete = STEPS.every((s) => done.includes(s.id));
  const headline = complete ? "Your wallets are ready" : active ? `${active.text}…` : "Checking your YEET wallets…";
  const fill = complete ? 100 : (FILL[step] ?? FILL.check);
  const state = failed ? "setup stopped" : complete ? "setup complete" : "setup";
  return (
    <div className={state} data-step={step}>
      <div className="setup-hero">
        <span className="setup-mark" aria-hidden="true">
          <img src="/account/brand/mark.svg" alt="" width="30" height="30" />
        </span>
        <p className="setup-step lead" role="status" aria-live="polite">
          {words(headline)}
        </p>
      </div>
      <div className={failed ? "setup-bar stopped" : "setup-bar"} aria-hidden="true">
        <span style={{ "--p": `${fill}%` }} />
      </div>
      <ol className="setup-steps">
        {STEPS.map((s) => {
          const state = done.includes(s.id) ? "done" : s.id === step ? "active" : "next";
          return (
            <li key={s.id} className={state}>
              <span className="dot" aria-hidden="true" />
              {words(s.text)}
              {state === "done" ? <span className="visually-hidden"> (done)</span> : null}
            </li>
          );
        })}
      </ol>
      {slow || failed ? (
        <>
          <p role="alert" className="notice">
            {words(
              failed
                ? message || "YEET could not finish setting up your wallets. Nothing was charged. Tap Try again."
                : "Setting up your wallets is taking longer than usual.",
            )}
          </p>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : null}
    </div>
  );
}
