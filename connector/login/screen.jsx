// Screen changes inside a page: the old screen leaves (CSS .screen.leaving, as/viewer/auth-pages.css), then the new
// one arrives. With prefers-reduced-motion the swap is instant. The rule is screen-swap.js (no React).
import React, { useEffect, useRef, useState } from "react";
import { exitMs, shownScreen } from "./screen-swap.js";

const outMs = (instant) => exitMs({ instant, reducedMotion: !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches });

/**
 * Shows `children` under the screen id `id`. When `id` changes, the last screen plays its exit first.
 * `instant`: no exit. The new screen replaces the old one in the same render, so nothing of the old screen (its
 * text, links or handlers) stays mounted. For screens that may only be shown while a condition holds.
 */
export function Swap({ id, children, instant = false }) {
  const [view, setView] = useState({ id, node: children, leaving: false });
  const latest = useRef(children);
  latest.current = children;
  useEffect(() => {
    if (id === view.id) return;
    const ms = outMs(instant);
    if (!ms) return setView({ id, node: latest.current, leaving: false });
    setView((v) => ({ ...v, leaving: true }));
    const timer = setTimeout(() => setView({ id, node: latest.current, leaving: false }), ms);
    return () => clearTimeout(timer);
    // view.id is read on purpose only when id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const shown = shownScreen({ id, view, instant });
  return (
    <div key={shown.id} className={shown.leaving ? "screen leaving" : "screen"} data-screen={shown.id}>
      {shown.from === "children" ? children : view.node}
    </div>
  );
}
