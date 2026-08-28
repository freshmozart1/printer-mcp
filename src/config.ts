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
const ENV_FILE = path.join(CONFIG_DIR, "env");

/**
 * Defaults that name no real device.
 *
 * The project ships placeholders rather than one household's printer, so an
 * unconfigured install can be recognised and reported as such instead of looking like
 * a printer that is switched off.
 */
export const PLACEHOLDER_PRINTER_HOST = "HPEXAMPLE12345.local";
export const PLACEHOLDER_CUPS_DEST = "HP_OfficeJet_Pro_9010_series__EXAMPLE_";
const TLS_KEY = path.join(CONFIG_DIR, "key.pem");

/**
 * Read `~/.config/printer-mcp/env` as KEY=VALUE defaults.
 *
 * The server is launched from several places — a LaunchAgent, Claude Code, the
 * desktop app — each with its own way of setting environment variables. A single
 * file keeps one source of truth instead of three that drift apart. Real environment
 * variables still win, so a one-off override works as expected.
 */
export function loadEnvFile(file: string = ENV_FILE): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Allow quoting so values with spaces survive.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
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

export function loadConfig(processEnv: NodeJS.ProcessEnv = process.env): Config {
  // File values are defaults; a real environment variable overrides them.
  const env: NodeJS.ProcessEnv = { ...loadEnvFile(), ...processEnv };
  const home = homedir();
  const scanDir = expandHome(env.PRINTER_MCP_SCAN_DIR ?? path.join(home, "Documents", "Scans"));

  return {
    printerHost: env.PRINTER_MCP_PRINTER_HOST ?? PLACEHOLDER_PRINTER_HOST,
    cupsDestination: env.PRINTER_MCP_CUPS_DEST ?? PLACEHOLDER_CUPS_DEST,
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

/** Settings still left at their placeholder, i.e. never configured. */
export function missingConfiguration(config: Config): string[] {
  const missing: string[] = [];
  if (config.printerHost === PLACEHOLDER_PRINTER_HOST) missing.push("PRINTER_MCP_PRINTER_HOST");
  if (config.cupsDestination === PLACEHOLDER_CUPS_DEST) missing.push("PRINTER_MCP_CUPS_DEST");
  return missing;
}

/** A setup message naming exactly what to set and where. */
export function setupInstructions(missing: string[]): string {
  return [
    `This server has not been pointed at a printer yet: ${missing.join(" and ")} ` +
      `${missing.length > 1 ? "are" : "is"} still at the shipped placeholder.`,
    "",
    `Create ${path.join("~", ".config", "printer-mcp", "env")} with:`,
    ...(missing.includes("PRINTER_MCP_PRINTER_HOST")
      ? ["  PRINTER_MCP_PRINTER_HOST=192.168.1.50        # the printer's address"]
      : []),
    ...(missing.includes("PRINTER_MCP_CUPS_DEST")
      ? ["  PRINTER_MCP_CUPS_DEST=Your_Queue_Name        # see `lpstat -p`"]
      : []),
    "",
    "Then restart this server. Run `lpstat -p` for the queue name; the address comes " +
      "from your router or the printer's own network menu.",
  ].join("\n");
}

/** Throw a setup message when the server has never been pointed at a printer. */
export function assertConfigured(config: Config): void {
  const missing = missingConfiguration(config);
  if (missing.length) throw new Error(setupInstructions(missing));
}
