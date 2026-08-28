import { setTimeout as delay } from "node:timers/promises";
import { withRetry } from "../retry.ts";
import { sharedTransport as transport } from "./transport.ts";
import type { HttpResult } from "./transport.ts";

export type ScanSource = "adf" | "adf-duplex" | "flatbed";
export type ScanColorMode = "color" | "grayscale" | "blackandwhite";
export type ScanFormat = "pdf" | "jpeg";
export type ScanIntent = "Document" | "Photo" | "Preview" | "TextAndGraphic";

export interface ScanRequest {
  source: ScanSource;
  format: ScanFormat;
  resolution: number;
  colorMode: ScanColorMode;
  intent?: ScanIntent;
}

export interface SourceCaps {
  maxWidth: number;
  maxHeight: number;
  resolutions: number[];
  colorModes: string[];
  documentFormats: string[];
}

export type Capabilities = Partial<Record<ScanSource, SourceCaps>>;

export interface ScannerStatus {
  state: string;
  adfState: string | undefined;
  adfLoaded: boolean;
}

const COLOR_MODES: Record<ScanColorMode, string> = {
  color: "RGB24",
  grayscale: "Grayscale8",
  blackandwhite: "BlackAndWhite1",
};

const FORMATS: Record<ScanFormat, string> = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
};

function tagValue(xml: string, localName: string): string | undefined {
  const m = new RegExp(`<(?:\\w+:)?${localName}>([^<]*)</(?:\\w+:)?${localName}>`).exec(xml);
  return m?.[1]?.trim();
}

function allTagValues(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${localName}>([^<]*)</(?:\\w+:)?${localName}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!.trim());
}

/** Extract the inner XML of the first `<ns:name>...</ns:name>` block. */
function section(xml: string, localName: string): string | undefined {
  const re = new RegExp(`<(?:\\w+:)?${localName}>([\\s\\S]*?)</(?:\\w+:)?${localName}>`);
  return re.exec(xml)?.[1];
}

export function parseScannerStatus(xml: string): ScannerStatus {
  const adfState = tagValue(xml, "AdfState");
  return {
    state: tagValue(xml, "State") ?? "Unknown",
    adfState,
    // Anything other than an explicitly loaded feeder counts as "no paper", so a jam
    // or a missing ADF never looks like a ready feeder.
    adfLoaded: adfState === "ScannerAdfLoaded",
  };
}

function parseSource(block: string | undefined): SourceCaps | undefined {
  if (!block) return undefined;
  const resolutions = [...new Set(allTagValues(block, "XResolution").map(Number))]
    .sort((a, b) => a - b);
  return {
    maxWidth: Number(tagValue(block, "MaxWidth") ?? 0),
    maxHeight: Number(tagValue(block, "MaxHeight") ?? 0),
    resolutions,
    colorModes: [...new Set(allTagValues(block, "ColorMode"))],
    documentFormats: [...new Set(allTagValues(block, "DocumentFormat"))],
  };
}

export function parseCapabilities(xml: string): Capabilities {
  return {
    flatbed: parseSource(section(xml, "PlatenInputCaps")),
    adf: parseSource(section(xml, "AdfSimplexInputCaps")),
    "adf-duplex": parseSource(section(xml, "AdfDuplexInputCaps")),
  };
}

/**
 * Build the eSCL ScanSettings document.
 *
 * Element order follows the eSCL schema sequence; scanners reject documents whose
 * elements appear out of order. Scan region units are 1/300 inch regardless of the
 * requested resolution.
 */
export function buildScanSettingsXml(req: ScanRequest, caps: Capabilities): string {
  const source = caps[req.source];
  if (!source) {
    throw new Error(
      `The scanner does not support the "${req.source}" source. ` +
        `Available: ${Object.keys(caps).filter((k) => caps[k as ScanSource]).join(", ")}`,
    );
  }

  if (source.resolutions.length && !source.resolutions.includes(req.resolution)) {
    throw new Error(
      `Unsupported resolution ${req.resolution} dpi. ` +
        `Supported: ${source.resolutions.join(", ")}.`,
    );
  }

  const duplex = req.source === "adf-duplex";
  const inputSource = req.source === "flatbed" ? "Platen" : "Feeder";

  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm" xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03">
  <pwg:Version>2.63</pwg:Version>
  <scan:Intent>${req.intent ?? "Document"}</scan:Intent>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${source.maxWidth}</pwg:Width>
      <pwg:Height>${source.maxHeight}</pwg:Height>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:DocumentFormat>${FORMATS[req.format]}</pwg:DocumentFormat>
  <pwg:InputSource>${inputSource}</pwg:InputSource>
  <scan:XResolution>${req.resolution}</scan:XResolution>
  <scan:YResolution>${req.resolution}</scan:YResolution>
  <scan:ColorMode>${COLOR_MODES[req.colorMode]}</scan:ColorMode>
  <scan:Duplex>${duplex}</scan:Duplex>
</scan:ScanSettings>
`;
}

const base = (host: string) => `https://${host}/eSCL`;

/** Which mechanism the scanner transport is currently using. */
export const scanTransportInUse = (): "node" | "curl" => transport.current();

/**
 * Perform one eSCL request, retrying connection-level failures.
 *
 * The printer sleeps when idle; the first attempt after that wakes it.
 */
function httpRequest(
  url: string,
  options: { method?: string; body?: string; timeoutMs?: number } = {},
): Promise<HttpResult> {
  return withRetry(() => transport(url, options));
}

export async function getScannerStatus(host: string): Promise<ScannerStatus> {
  const res = await httpRequest(`${base(host)}/ScannerStatus`, { timeoutMs: 15_000 });
  if (res.status !== 200) throw new Error(`Scanner status request failed (HTTP ${res.status})`);
  return parseScannerStatus(res.body.toString("utf8"));
}

export async function getCapabilities(host: string): Promise<Capabilities> {
  const res = await httpRequest(`${base(host)}/ScannerCapabilities`, { timeoutMs: 15_000 });
  if (res.status !== 200) {
    throw new Error(`Scanner capabilities request failed (HTTP ${res.status})`);
  }
  return parseCapabilities(res.body.toString("utf8"));
}

/**
 * Run a scan job and return each document the scanner produces.
 *
 * For a PDF the scanner assembles every fed sheet into one document, so this usually
 * returns a single buffer; JPEG scans return one buffer per page.
 */
export async function scan(host: string, req: ScanRequest, caps: Capabilities): Promise<Buffer[]> {
  const settings = buildScanSettingsXml(req, caps);

  const created = await httpRequest(`${base(host)}/ScanJobs`, {
    method: "POST",
    body: settings,
    timeoutMs: 30_000,
  });

  if (created.status !== 201) {
    throw new Error(
      `Scanner rejected the scan job (HTTP ${created.status}): ` +
        created.body.toString("utf8").slice(0, 300),
    );
  }

  const location = created.headers.location;
  const jobUrl = Array.isArray(location) ? location[0] : location;
  if (!jobUrl) throw new Error("Scanner did not return a job location");

  // HP returns an absolute URL; normalise in case a relative one appears.
  const job = jobUrl.startsWith("http") ? jobUrl : `https://${host}${jobUrl}`;

  const documents: Buffer[] = [];
  try {
    while (true) {
      const doc = await httpRequest(`${job}/NextDocument`, { timeoutMs: 180_000 });
      // 404/410 is the documented way of saying "no more pages".
      if (doc.status === 404 || doc.status === 410) break;
      if (doc.status === 503) {
        await delay(1000); // Scanner still warming up.
        continue;
      }
      if (doc.status !== 200) {
        throw new Error(`Scan failed while fetching a page (HTTP ${doc.status})`);
      }
      if (doc.body.length === 0) break;
      documents.push(doc.body);
    }
  } finally {
    // Best effort: releasing the job lets the next scan start immediately.
    await httpRequest(job, { method: "DELETE", timeoutMs: 10_000 }).catch(() => {});
  }

  if (documents.length === 0) throw new Error("The scanner returned no pages");
  return documents;
}
