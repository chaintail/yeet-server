// Which screen a Swap (screen.jsx) puts in the tree, without React.
//
// A screen change normally plays the old screen's exit first: the OLD node stays mounted, with its handlers, for
// the length of the animation. That is wrong for a screen that shows something a person may act on only while a
// condition holds (the funding page: an address, wallet links and payment buttons that belong to ONE approved
// account). `instant` is for those: the new screen is in the tree in the very render in which the id changed, and
// the old node is never rendered again.
export const OUT_MS = 420;
/**
 * id: the screen asked for now. view: {id, leaving} the screen the Swap last settled on.
 * -> {id, from: "children" | "kept", leaving}
 *   from "children": render what the parent passed in this render      from "kept": render the node kept from before
 */
export function shownScreen({ id, view, instant = false }) {
  if (id === view.id) return { id, from: "children", leaving: false };
  if (instant) return { id, from: "children", leaving: false };
  return { id: view.id, from: "kept", leaving: !!view.leaving };
}
/** How long the old screen stays: nothing when instant or with reduced motion. */
export const exitMs = ({ instant = false, reducedMotion = false } = {}) => (instant || reducedMotion ? 0 : OUT_MS);
