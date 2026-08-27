import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface Config {
  /** Hostname or IP of the printer, used for eSCL scanning. */
  printerHost: string;
  /** CUPS destination name, used for printing. */
  cupsDestination: string;
  /** Where completed scans are written. */
  scanDir: string;
  /** Directories `print_file` may read from. */
  allowedPrintDirs: string[];
  port: number;
  bindHost: string;
  /** Bearer token required by the HTTP transport. */
  token: string;
  ocrLanguages: string[];
  ocrDpi: number;
  /** TLS key/cert paths, when HTTPS is enabled. */
  tls: { key: string; cert: string } | undefined;
}

const CONFIG_DIR = path.join(homedir(), ".config", "printer-mcp");
const TOKEN_FILE = path.join(CONFIG_DIR, "token");
const TLS_KEY = path.join(CONFIG_DIR, "key.pem");
const TLS_CERT = path.join(CONFIG_DIR, "cert.pem");

/**
 * Resolve the TLS material, if any.
 *
 * HTTPS turns on automatically once `scripts/generate-cert.sh` has produced a
 * key/certificate pair, and can be forced off with PRINTER_MCP_TLS=0. Serving over
 * plain HTTP would put the bearer token and every scanned page on the WLAN in clear.
 */
function resolveTls(env: NodeJS.ProcessEnv): { key: string; cert: string } | undefined {
  if (env.PRINTER_MCP_TLS === "0") return undefined;
  const key = expandHome(env.PRINTER_MCP_TLS_KEY ?? TLS_KEY);
  const cert = expandHome(env.PRINTER_MCP_TLS_CERT ?? TLS_CERT);
  return existsSync(key) && existsSync(cert) ? { key, cert } : undefined;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve `candidate` and confirm it is a real file inside one of `allowedDirs`.
 *
 * This is the guard that stops a caller on the LAN reading arbitrary files. Both sides
 * are passed through `realpath` first, so `..` segments and symlinks that point out of
 * an allowed directory are caught. Containment is checked with `path.relative` rather
 * than a string prefix, so `/x/Documents-secret` does not pass for `/x/Documents`.
 */
export async function resolveAllowedPath(
  candidate: string,
  allowedDirs: string[],
): Promise<string> {
  const absolute = path.resolve(expandHome(candidate));

  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw new Error(`File not found: ${absolute}`);
  }

  const info = await stat(real);
  if (!info.isFile()) throw new Error(`Not a file: ${absolute}`);

  for (const dir of allowedDirs) {
    let realDir: string;
    try {
      realDir = await realpath(path.resolve(expandHome(dir)));
    } catch {
      continue; // A configured directory that does not exist simply allows nothing.
    }
    const rel = path.relative(realDir, real);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return real;
  }

  throw new Error(
    `Path is outside the allowed directories: ${absolute}. ` +
      `Allowed: ${allowedDirs.join(", ") || "(none configured)"}`,
  );
}

/** Read the bearer token, creating one on first run. */
export function loadOrCreateToken(): string {
  const fromEnv = process.env.PRINTER_MCP_TOKEN;
  if (fromEnv) return fromEnv;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = homedir();
  const scanDir = expandHome(env.PRINTER_MCP_SCAN_DIR ?? path.join(home, "Documents", "Scans"));

  return {
    printerHost: env.PRINTER_MCP_PRINTER_HOST ?? "HPEXAMPLE12345.local",
    cupsDestination: env.PRINTER_MCP_CUPS_DEST ?? "HP_OfficeJet_Pro_9010_series__EXAMPLE_",
    scanDir,
    allowedPrintDirs: list(env.PRINTER_MCP_ALLOWED_DIRS, [
      path.join(home, "Documents"),
      path.join(home, "Downloads"),
      path.join(home, "Desktop"),
      scanDir,
    ]).map(expandHome),
    port: Number(env.PRINTER_MCP_PORT ?? 8765),
    bindHost: env.PRINTER_MCP_BIND ?? "0.0.0.0",
    token: loadOrCreateToken(),
    ocrLanguages: list(env.PRINTER_MCP_OCR_LANGUAGES, ["de-DE", "en-US"]),
    ocrDpi: Number(env.PRINTER_MCP_OCR_DPI ?? 200),
    tls: resolveTls(env),
  };
}

/** Ensure the scan output directory exists. */
export function ensureScanDir(config: Config): void {
  mkdirSync(config.scanDir, { recursive: true });
}
