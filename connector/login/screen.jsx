// Screen changes inside a page: the old screen leaves (CSS .screen.leaving, as/viewer/auth-pages.css), then the new
// one arrives. With prefers-reduced-motion the swap is instant.
import React, { useEffect, useRef, useState } from "react";

const OUT_MS = 420;
const outMs = () => (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : OUT_MS);

/** Shows `children` under the screen id `id`. When `id` changes, the last screen plays its exit first. */
export function Swap({ id, children }) {
  const [view, setView] = useState({ id, node: children, leaving: false });
  const latest = useRef(children);
  latest.current = children;
  useEffect(() => {
    if (id === view.id) return;
    const ms = outMs();
    if (!ms) return setView({ id, node: latest.current, leaving: false });
    setView((v) => ({ ...v, leaving: true }));
    const timer = setTimeout(() => setView({ id, node: latest.current, leaving: false }), ms);
    return () => clearTimeout(timer);
    // view.id is read on purpose only when id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const current = id === view.id;
  return (
    <div key={view.id} className={!current && view.leaving ? "screen leaving" : "screen"} data-screen={view.id}>
      {current ? children : view.node}
    </div>
  );
}
