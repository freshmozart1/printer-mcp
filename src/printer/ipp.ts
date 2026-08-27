import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATTRIBUTES_REQUEST = path.join(HERE, "get-attributes.ipptest");

export interface Supply {
  name: string;
  color: string | undefined;
  type: string | undefined;
  levelPercent: number;
}

export interface PrinterStatus {
  state: "idle" | "processing" | "stopped" | "unknown";
  stateReasons: string[];
  stateMessage: string | undefined;
  makeAndModel: string | undefined;
  mediaReady: string | undefined;
  mediaDefault: string | undefined;
  supplies: Supply[];
  sidesSupported: string[];
  colorModesSupported: string[];
}

/** IPP printer-state enum (RFC 8011 §5.4.11). */
const STATES: Record<number, PrinterStatus["state"]> = {
  3: "idle",
  4: "processing",
  5: "stopped",
};

function asArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

/**
 * Flatten the `ResponseAttributes` groups of an `ipptool -X` plist (already converted
 * to JSON by `plutil`) into a single attribute map.
 */
export function mergeResponseAttributes(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as {
    Tests?: Array<{
      Successful?: boolean;
      StatusCode?: string;
      ResponseAttributes?: Array<Record<string, unknown>>;
    }>;
  };

  const test = parsed.Tests?.[0];
  if (!test) throw new Error("ipptool returned no IPP response");
  if (test.Successful === false) {
    throw new Error(`IPP request failed: ${test.StatusCode ?? "unknown status"}`);
  }

  return Object.assign({}, ...(test.ResponseAttributes ?? [])) as Record<string, unknown>;
}

export function toPrinterStatus(attrs: Record<string, unknown>): PrinterStatus {
  const names = asArray(attrs["marker-names"]);
  const colors = asArray(attrs["marker-colors"]);
  const types = asArray(attrs["marker-types"]);
  const levels = asArray(attrs["marker-levels"]).map(Number);

  const supplies: Supply[] = names.map((name, i) => ({
    name,
    color: colors[i],
    type: types[i],
    levelPercent: levels[i] ?? -1,
  }));

  // "none" is IPP's way of saying nothing is wrong; it is noise in a status report.
  const stateReasons = asArray(attrs["printer-state-reasons"]).filter((r) => r !== "none");

  const stateMessage = attrs["printer-state-message"];

  return {
    state: STATES[Number(attrs["printer-state"])] ?? "unknown",
    stateReasons,
    stateMessage: stateMessage ? String(stateMessage) : undefined,
    makeAndModel: attrs["printer-make-and-model"] as string | undefined,
    mediaReady: asArray(attrs["media-ready"])[0],
    mediaDefault: asArray(attrs["media-default"])[0],
    supplies,
    sidesSupported: asArray(attrs["sides-supported"]),
    colorModesSupported: asArray(attrs["print-color-mode-supported"]),
  };
}

/** Query the printer over IPP and return its status. */
export async function queryPrinterStatus(printerHost: string): Promise<PrinterStatus> {
  const uri = `ipps://${printerHost}:631/ipp/print`;
  const { stdout: plist } = await run("ipptool", ["-X", uri, ATTRIBUTES_REQUEST], {
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  // Let macOS parse its own plist format rather than hand-rolling a parser.
  const json = await plutilToJson(plist);
  return toPrinterStatus(mergeResponseAttributes(json));
}

/** Convert an XML plist to JSON by piping it through macOS' own `plutil`. */
function plutilToJson(plist: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("plutil", ["-convert", "json", "-o", "-", "-"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`plutil failed: ${err.trim()}`)));
    child.stdin.on("error", reject);
    child.stdin.end(plist);
  });
}
