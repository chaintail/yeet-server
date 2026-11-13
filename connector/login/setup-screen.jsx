// The waiting screen while YEET sets up the wallets: an animated progress bar (CSS in as/viewer/auth-pages.css,
// still under prefers-reduced-motion) and the step list from wallet-setup.js. No Privy here, so it renders anywhere.
import React from "react";
import { STEPS } from "./wallet-setup.js";

/**
 * step: "base" | "solana" | "link" | "check". done: step ids already finished. slow: the setup has taken longer than
 * usual (shows the notice and onRetry's button).
 */
export function SetupProgress({ step, done = [], slow = false, failed = false, onRetry }) {
  const active = STEPS.find((s) => s.id === step);
  const headline = active ? `${active.text}…` : "Checking your YEET wallets…";
  return (
    <div className="setup" data-step={step}>
      <p className="setup-step lead" role="status" aria-live="polite">
        {headline}
      </p>
      <div className={failed ? "setup-bar stopped" : "setup-bar"} aria-hidden="true">
        <span />
      </div>
      <ol className="setup-steps">
        {STEPS.map((s) => {
          const state = done.includes(s.id) ? "done" : s.id === step ? "active" : "next";
          return (
            <li key={s.id} className={state}>
              <span className="dot" aria-hidden="true" />
              {s.text}
              {state === "done" ? <span className="visually-hidden"> (done)</span> : null}
            </li>
          );
        })}
      </ol>
      {slow || failed ? (
        <>
          <p role="alert" className="notice">
            {failed
              ? "YEET could not finish setting up your wallets. Nothing was charged. Tap Try again."
              : "Setting up your wallets is taking longer than usual."}
          </p>
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : null}
    </div>
  );
}
