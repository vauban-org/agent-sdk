// agent-sdk is an ESM Node library (it imports node:crypto, ioredis, pg, ...).
// The size gate must measure it as node+esm: the default browser platform cannot
// resolve node built-ins ("Could not resolve node:crypto"), and the cjs output
// format breaks on `import.meta`. `modifyEsbuildConfig` sets platform=node (so
// built-ins and node-only deps are external) and format=esm (matches the package).
//
// Limits are the first real baseline (the gate previously errored before measuring,
// so the old 200/50/30/40 kB values were never enforced). They sit ~15% above the
// current minified+brotli size to act as a forward ratchet on unexpected growth.
const nodeEsm = (config) => {
  config.platform = "node";
  config.format = "esm";
  return config;
};

export default [
  {
    name: "agent-sdk core",
    path: "dist/index.js",
    limit: "560 KB",
    modifyEsbuildConfig: nodeEsm,
  },
  {
    name: "agent-sdk testing",
    path: "dist/testing/index.js",
    limit: "90 KB",
    modifyEsbuildConfig: nodeEsm,
  },
  {
    name: "agent-sdk proof",
    // Re-ratcheté 30→3 KB le 2026-09-01 : l'extraction du moteur de grading
    // (paquet workspace privé) a vidé ce budget ; 2,19 kB mesurés + ~15 %.
    path: "dist/proof/index.js",
    limit: "3 KB",
    modifyEsbuildConfig: nodeEsm,
  },
  {
    name: "agent-sdk OODA",
    path: "dist/orchestration/ooda/index.js",
    limit: "65 KB",
    modifyEsbuildConfig: nodeEsm,
  },
];
