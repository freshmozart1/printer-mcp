import { sharedTransport } from "../scanner/transport.ts";
import { withRetry } from "../retry.ts";
import type { PrinterStatus, Supply } from "./ipp.ts";

/**
 * Read printer status from HP's DevMgmt HTTP endpoints.
 *
 * A fallback for when `ipptool` cannot reach the printer. It goes through the shared
 * transport, so in a process that is denied raw sockets — which is how Claude launches
 * MCP servers — these requests still succeed via curl where `ipptool` cannot.
 *
 * It reports less than IPP does: there is no media information here, so the loaded
 * paper size is unknown on this path.
 */

/** HP status categories that describe a fault rather than normal operation. */
const INFORMATIONAL = new Set(["genuineHP", "inPowerSave", "ready", "processing"]);

const BUSY = new Set(["processing", "printing", "scanning", "copying"]);

function values(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${localName}>([^<]*)</(?:\\w+:)?${localName}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!.trim()).filter(Boolean);
}

export function parseStatusCategories(xml: string): string[] {
  return values(xml, "StatusCategory");
}

/** Cartridge colour codes as HP reports them. */
const COLOR_NAMES: Record<string, { name: string; color: string }> = {
  C: { name: "cyan cartridge", color: "#00FFFF" },
  M: { name: "magenta cartridge", color: "#FF00FF" },
  Y: { name: "yellow cartridge", color: "#FFFF00" },
  K: { name: "black cartridge", color: "#000000" },
};

export function parseConsumables(xml: string): Supply[] {
  const blocks = [...xml.matchAll(/<(?:\w+:)?ConsumableInfo>([\s\S]*?)<\/(?:\w+:)?ConsumableInfo>/g)]
    .map((m) => m[1]!);

  const supplies: Supply[] = [];
  for (const block of blocks) {
    // The printhead is listed alongside the cartridges but holds no ink.
    if (values(block, "ConsumableTypeEnum")[0] !== "ink") continue;

    const label = values(block, "ConsumableLabelCode")[0] ?? "";
    const percent = Number(values(block, "ConsumablePercentageLevelRemaining")[0] ?? -1);
    const known = COLOR_NAMES[label];
    supplies.push({
      name: known?.name ?? `${label} cartridge`,
      color: known?.color,
      type: "ink-cartridge",
      levelPercent: Number.isFinite(percent) ? percent : -1,
    });
  }
  return supplies;
}

export function toPrinterStatus(statusXml: string, consumablesXml: string): PrinterStatus {
  const categories = parseStatusCategories(statusXml);
  const reasons = categories.filter((c) => !INFORMATIONAL.has(c));

  return {
    state: categories.some((c) => BUSY.has(c))
      ? "processing"
      : reasons.length > 0
        ? "stopped"
        : "idle",
    stateReasons: reasons,
    stateMessage: undefined,
    makeAndModel: undefined,
    // DevMgmt does not report the loaded media.
    mediaReady: undefined,
    mediaDefault: undefined,
    supplies: parseConsumables(consumablesXml),
    sidesSupported: [],
    colorModesSupported: [],
  };
}

export async function queryStatusOverHttp(printerHost: string): Promise<PrinterStatus> {
  const get = async (path: string): Promise<string> => {
    const res = await withRetry(() =>
      sharedTransport(`https://${printerHost}${path}`, { timeoutMs: 15_000 }));
    if (res.status !== 200) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.body.toString("utf8");
  };

  const [status, consumables] = await Promise.all([
    get("/DevMgmt/ProductStatusDyn.xml"),
    get("/DevMgmt/ConsumableConfigDyn.xml"),
  ]);

  return toPrinterStatus(status, consumables);
}
