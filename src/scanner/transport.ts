import { execFile } from "node:child_process";
import { Agent, request } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RequestOptions {
  method?: string;
  body?: string;
  timeoutMs?: number;
}

/** The printer serves eSCL over HTTPS with a self-signed certificate. */
function agentFor(): Agent {
  return new Agent({ rejectUnauthorized: false, keepAlive: false });
}

/** Talk to the scanner using Node's own sockets. */
export function nodeRequest(url: string, options: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        host: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        agent: agentFor(),
        timeout: options.timeoutMs ?? 120_000,
        headers: options.body
          ? { "Content-Type": "text/xml", "Content-Length": Buffer.byteLength(options.body) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? "") : String(v ?? "");
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`Scanner timed out: ${url}`)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Parse the status line and headers from `curl -D`. */
export function parseCurlHeaders(dump: string): { status: number; headers: Record<string, string> } {
  // A redirect or a 100-continue produces several blocks; the last one is the answer.
  const blocks = dump.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  const last = blocks[blocks.length - 1] ?? "";
  const lines = last.split(/\r?\n/);

  const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status, headers };
}

/**
 * Talk to the scanner by running `curl`.
 *
 * Claude launches MCP servers through a wrapper that sets the macOS disclaim
 * attribute, so the server is responsible for its own TCC permissions rather than
 * inheriting the app's. A bare `node` binary has no Local Network grant, so its
 * sockets to the printer fail with EHOSTUNREACH; Apple-signed `/usr/bin/curl` still
 * gets through. Bodies go via files so a large scan is never held in an argument list.
 */
export async function curlRequest(url: string, options: RequestOptions = {}): Promise<HttpResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "printer-mcp-curl-"));
  const headerFile = path.join(dir, "headers");
  const bodyFile = path.join(dir, "body");
  const timeoutSec = Math.ceil((options.timeoutMs ?? 120_000) / 1000);

  try {
    const args = [
      "-s", "-k",
      "--max-time", String(timeoutSec),
      "-D", headerFile,
      "-o", bodyFile,
      "-X", options.method ?? "GET",
    ];

    if (options.body) {
      const requestFile = path.join(dir, "request");
      await writeFile(requestFile, options.body);
      args.push("-H", "Content-Type: text/xml", "--data-binary", `@${requestFile}`);
    }

    args.push(url);
    await run("curl", args, { timeout: (options.timeoutMs ?? 120_000) + 5000 });

    const [dump, body] = await Promise.all([
      readFile(headerFile, "utf8").catch(() => ""),
      readFile(bodyFile).catch(() => Buffer.alloc(0)),
    ]);

    const { status, headers } = parseCurlHeaders(dump);
    return { status, headers, body };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Errors that mean this process is not allowed to reach the printer. */
const BLOCKED = new Set(["EHOSTUNREACH", "EBADF", "ENETUNREACH", "EPERM", "EACCES"]);

export function isBlockedByPolicy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && BLOCKED.has(code)) return true;
  const nested = (error as { errors?: unknown }).errors;
  return Array.isArray(nested) && nested.some(isBlockedByPolicy);
}

export type TransportMode = "auto" | "node" | "curl";

export interface Transport {
  (url: string, options?: RequestOptions): Promise<HttpResult>;
  /** Which mechanism the transport settled on, for reporting. */
  readonly current: () => "node" | "curl";
}

/**
 * Build a request function.
 *
 * In "auto" it prefers Node's sockets and falls back to curl the first time a request
 * is refused by policy, remembering the choice so the cost is paid once rather than on
 * every request.
 */
export function createTransport(
  mode: TransportMode = "auto",
  deps: { node?: typeof nodeRequest; curl?: typeof curlRequest; onFallback?: () => void } = {},
): Transport {
  const viaNode = deps.node ?? nodeRequest;
  const viaCurl = deps.curl ?? curlRequest;
  let active: "node" | "curl" = mode === "curl" ? "curl" : "node";

  const transport = (async (url: string, options: RequestOptions = {}) => {
    if (active === "curl") return viaCurl(url, options);

    try {
      return await viaNode(url, options);
    } catch (error) {
      if (mode !== "auto" || !isBlockedByPolicy(error)) throw error;
      // This process cannot open sockets to the printer; use curl from here on.
      active = "curl";
      deps.onFallback?.();
      return viaCurl(url, options);
    }
  }) as Transport;

  Object.defineProperty(transport, "current", { value: () => active });
  return transport;
}
