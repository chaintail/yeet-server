// The brand's rule for text: the word YEET is always followed by the bolt (the same path as the cards and the
// landing page). Decoration only: the bolt is hidden from screen readers, so the words read as written.
import React from "react";

export function Bolt() {
  return (
    <svg className="wm" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M14.2 1.5 4.5 13.6h6.1L9 22.5l10.5-12.7h-6.4z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** A string with the bolt after every YEET, ready to render; any other value comes back as it was. One span, so a
 *  flex parent (a button, a step) keeps the words together. */
export function words(text) {
  if (typeof text !== "string" || !/\bYEET\b/.test(text)) return text;
  return <span>{text.split(/\b(YEET)\b/).map((part, i) =>
    i % 2 ? (
      <span className="sw" key={i}>
        YEET
        <Bolt />
      </span>
    ) : (
      part
    ),
  )}</span>;
}
