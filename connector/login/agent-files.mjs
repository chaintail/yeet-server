// The files of the agent approval page's bundle: agent.js and every chunk it imports, statically or dynamically.
// login/build.mjs writes them to dist/agent-files.json from esbuild's metafile; the sign-in server serves only these
// bundle files on the agent host (as/agent-page.mjs). No dependency: the image's login build stage has only login/.
export const AGENT_MANIFEST = "agent-files.json";

/** File names (no directory) reachable from `entry` in an esbuild metafile's outputs. */
export function agentBundleFiles(metafile, entry = "agent.js") {
  const outputs = metafile?.outputs ?? {};
  const name = (p) => p.split("/").pop();
  const byName = new Map(Object.keys(outputs).map((p) => [name(p), outputs[p]]));
  const seen = new Set();
  const walk = (n) => {
    if (seen.has(n) || !byName.has(n)) return;
    seen.add(n);
    for (const i of byName.get(n).imports ?? []) if (!i.external) walk(name(i.path));
  };
  walk(entry);
  return [...seen].sort();
}
