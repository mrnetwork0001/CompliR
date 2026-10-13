#!/usr/bin/env node
/**
 * complir-mcp — MCP server for CompliR. Runs the TypeScript sources directly with Node's built-in type stripping
 * (Node >= 22.18 / 23.6; on 22.6–22.17 run with `node --experimental-strip-types`).
 *
 * The sources use extensionless relative imports (so the repo's tsc / vitest configs accept them); Node's ESM
 * loader needs explicit extensions, so this hook appends ".ts" to relative specifiers that resolve to a .ts file.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.(m?[jt]s|json)$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
    return next(specifier, context);
  },
});

const { main } = await import("../src/cli.ts");
main().catch((e) => {
  process.stderr.write(`[complir-mcp] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
