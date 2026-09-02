/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "sdk-no-forge",
      comment: "SDK must not import from Forge. Forge depends on SDK, never the reverse.",
      severity: "error",
      from: { path: "^command-center/packages/agent-sdk" },
      to: { path: "^forge" },
    },
    {
      name: "sdk-no-runtime-deps",
      comment: "SDK must not depend on runtime-specific libraries. Define a port instead.",
      severity: "error",
      from: { path: "^command-center/packages/agent-sdk/src" },
      to: {
        dependencyTypes: ["npm"],
        pathNot: "^(@opentelemetry|zod|@anthropic-ai|@vauban-org|bullmq|ioredis|json-canonicalize|pino|yaml)",
      },
    },
    {
      name: "sdk-no-forge-imports",
      comment: "SDK source must not import forge paths (relative or absolute).",
      severity: "error",
      from: { path: "^command-center/packages/agent-sdk/src" },
      to: { path: "forge" },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules", "dist"],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
    },
    reporterOptions: {
      dot: { collapsePattern: "node_modules/[^/]+" },
      archi: { collapsePattern: "node_modules/[^/]+" },
    },
  },
};
