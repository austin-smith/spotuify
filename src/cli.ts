#!/usr/bin/env bun
const argv = process.argv.slice(2);

if (argv.length === 0) {
  // The renderer is intentionally lazy: every CLI-only path remains free of terminal ownership,
  // native playback startup, and browser authentication side effects.
  await import("./index.tsx");
} else {
  // Bun's source transpiler otherwise creates an XDG cache entry merely to print help/version.
  // Installed binaries are precompiled; disabling that source-only cache keeps informational
  // commands genuinely read-only for development and tests as well.
  process.env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] ??= "0";
  const { runCli } = await import("./cli/program.ts");
  process.exitCode = await runCli(argv);
}
