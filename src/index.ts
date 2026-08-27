#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { createServer } from "./server.ts";
import { ensureScanDir, loadConfig } from "./config.ts";
import { filesRouter } from "./http/files.ts";
import { lanAddress } from "./files.ts";
import type { Config } from "./config.ts";

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Require the bearer token on every request except the signed file downloads. */
function requireToken(config: Config): express.RequestHandler {
  return (req, res, next) => {
    if (req.path.startsWith("/files/")) return next(); // Guarded by its own signature.

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !constantTimeEquals(token, config.token)) {
      res.status(401)
        .set("WWW-Authenticate", 'Bearer realm="printer-mcp"')
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: a valid bearer token is required" },
          id: null,
        });
      return;
    }
    next();
  };
}

async function runStdio(config: Config): Promise<void> {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol, so status goes to stderr.
  console.error("printer-mcp ready on stdio");
}

async function runHttp(config: Config): Promise<void> {
  const app = express();

  // DNS-rebinding protection: only accept requests addressed to this machine.
  const allowedHosts = [
    "localhost", "127.0.0.1", "[::1]",
    lanAddress(),
    ...(process.env.PRINTER_MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
  ];
  app.use(hostHeaderValidation(allowedHosts));

  // Liveness check, deliberately unauthenticated: it reveals only that the process is
  // up, and monitoring needs to reach it without holding the token.
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(requireToken(config));
  app.use(filesRouter(config));
  app.use(express.json({ limit: "4mb" }));

  // One transport per session, so several clients can connect at once.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await createServer(config).connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  await new Promise<void>((resolve) => {
    app.listen(config.port, config.bindHost, () => resolve());
  });

  const address = lanAddress();
  console.error(`printer-mcp listening on http://${config.bindHost}:${config.port}`);
  console.error(`  MCP endpoint:  http://${address}:${config.port}/mcp`);
  console.error(`  Bearer token:  ${config.token}`);
  console.error(`  Scans saved to ${config.scanDir}`);
}

const config = loadConfig();
ensureScanDir(config);

const useHttp = process.argv.includes("--http") || process.env.PRINTER_MCP_HTTP === "1";
await (useHttp ? runHttp(config) : runStdio(config));
