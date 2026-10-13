/**
 * Entry point for `complir-mcp`: stdio by default, Streamable HTTP with `--http [port]` (or COMPLIR_MCP_HTTP_PORT).
 *
 * Env: COMPLIR_URL (default http://localhost:3000), COMPLIR_PAYER_PRIVATE_KEY (optional; enables paid tools),
 *      COMPLIR_MAX_PRICE_USDC (default 0.1).
 * Never write to stdout in stdio mode: it is the JSON-RPC channel. Logs go to stderr.
 */
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Api, type ApiOptions } from "./api";
import { createServer, SERVER_VERSION } from "./server";

export type Env = Record<string, string | undefined>;

export function readEnv(env: Env = process.env): ApiOptions {
  const baseUrl = (env.COMPLIR_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  const payerPrivateKey = env.COMPLIR_PAYER_PRIVATE_KEY?.trim() || undefined;
  const maxRaw = env.COMPLIR_MAX_PRICE_USDC?.trim();
  const maxPriceUsdc = maxRaw ? Number(maxRaw) : 0.1;
  if (!Number.isFinite(maxPriceUsdc) || maxPriceUsdc < 0) throw new Error(`COMPLIR_MAX_PRICE_USDC must be a non-negative number, got "${maxRaw}"`);
  return { baseUrl, payerPrivateKey, maxPriceUsdc };
}

function log(msg: string): void {
  process.stderr.write(`[complir-mcp] ${msg}\n`);
}

export async function main(argv: string[] = process.argv.slice(2), env: Env = process.env): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      `complir-mcp v${SERVER_VERSION} - MCP server for CompliR\n\n` +
        `Usage: complir-mcp            stdio transport (for Claude Desktop / Claude Code / Cursor)\n` +
        `       complir-mcp --http [port]   Streamable HTTP on http://127.0.0.1:<port>/mcp (default 3333)\n\n` +
        `Env: COMPLIR_URL, COMPLIR_PAYER_PRIVATE_KEY, COMPLIR_MAX_PRICE_USDC, COMPLIR_MCP_HTTP_PORT\n`,
    );
    return;
  }
  const opts = readEnv(env);
  const api = new Api(opts);
  log(`CompliR at ${opts.baseUrl}; payer ${api.payerAddress ?? "none (paid tools will ask for COMPLIR_PAYER_PRIVATE_KEY)"}; max ${opts.maxPriceUsdc} USDC/call`);

  const httpIdx = argv.indexOf("--http");
  const httpPort = httpIdx >= 0 ? Number(argv[httpIdx + 1] ?? env.COMPLIR_MCP_HTTP_PORT ?? 3333) : env.COMPLIR_MCP_HTTP_PORT ? Number(env.COMPLIR_MCP_HTTP_PORT) : null;

  if (httpPort !== null) {
    await serveHttp(api, Number.isFinite(httpPort) ? httpPort : 3333);
    return;
  }
  const server = createServer(api);
  await server.connect(new StdioServerTransport());
  log("stdio transport connected");
}

/** Stateless Streamable HTTP: a fresh McpServer + transport per request (no sessions, no SSE resumability). */
export async function serveHttp(api: Api, port: number, host = "127.0.0.1"): Promise<() => Promise<void>> {
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found; MCP endpoint is /mcp" }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createServer(api);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => resolve());
  });
  log(`Streamable HTTP listening on http://${host}:${port}/mcp`);
  return () => new Promise<void>((resolve) => http.close(() => resolve()));
}
