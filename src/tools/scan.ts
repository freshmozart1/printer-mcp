import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCapabilities, getScannerStatus, scan } from "../scanner/escl.ts";
import type { ScanRequest, ScanSource } from "../scanner/escl.ts";
import { printFile } from "../printer/cups.ts";
import { ocrFile } from "../ocr/index.ts";
import { downloadUrl, lanAddress, makePreview, safeBaseName, saveScan, timestamp } from "../files.ts";
import { startProgress } from "../progress.ts";
import type { Config } from "../config.ts";

const sourceSchema = z.enum(["adf", "adf-duplex", "flatbed"]);

/**
 * Refuse to start a feeder job when the feeder is empty.
 *
 * Falling back to the glass would silently return blank pages — and for copy_document
 * would actually print them — so this fails loudly with a usable instruction instead.
 */
async function assertSourceReady(host: string, source: ScanSource): Promise<void> {
  if (source === "flatbed") return;
  const status = await getScannerStatus(host);
  if (!status.adfLoaded) {
    throw new Error(
      "The document feeder is empty. Put the pages in the feeder on top of the " +
        "printer and try again, or use source 'flatbed' to scan a single page from " +
        "the glass.",
    );
  }
}

export function registerScanTools(server: McpServer, config: Config): void {
  server.registerTool(
    "scan_document",
    {
      title: "Scan a document",
      description:
        "Scan pages on the HP OfficeJet Pro 9015e and save them. Scans from the " +
        "document feeder by default, which handles multi-page documents and produces " +
        "a single PDF; use source 'flatbed' for a single page on the glass, or " +
        "'adf-duplex' to scan both sides of each sheet. The saved file is the " +
        "authoritative result. Optional OCR returns the text of the page, but it is " +
        "best-effort and may contain recognition errors, so do not treat it as an " +
        "exact transcription of anything critical.",
      inputSchema: {
        source: sourceSchema.optional()
          .describe(
            "Where to scan from. 'adf' (default) is the document feeder on top of the " +
            "printer, 'adf-duplex' scans both sides of each sheet, 'flatbed' is the glass.",
          ),
        format: z.enum(["pdf", "jpeg"]).optional()
          .describe("Output format. 'pdf' (default) suits documents; 'jpeg' suits photos."),
        resolution: z.number().int().optional()
          .describe("Scan resolution in dpi (75, 100, 150, 200, 300, 400, 600, 1200). Default 300."),
        color: z.enum(["color", "grayscale", "blackandwhite"]).optional()
          .describe("Colour mode. Default 'color'."),
        intent: z.enum(["Document", "Photo", "Preview", "TextAndGraphic"]).optional()
          .describe("Tells the scanner what it is scanning so it can tune processing."),
        filename: z.string().optional()
          .describe("Base name for the saved file. Defaults to a timestamped name."),
        ocr: z.boolean().optional()
          .describe("Extract text from the scan with on-device OCR. Default false."),
        include_preview: z.boolean().optional()
          .describe(
            "Return a small inline image of the first page so you can look at it. " +
            "Defaults to true for single-page scans. Costs roughly 5-10k tokens.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const source = args.source ?? "adf";
      const format = args.format ?? "pdf";

      await assertSourceReady(config.printerHost, source);

      const caps = await getCapabilities(config.printerHost);
      const request: ScanRequest = {
        source,
        format,
        resolution: args.resolution ?? 300,
        colorMode: args.color ?? "color",
        intent: args.intent,
      };

      const stopProgress = startProgress(extra, "Scanning");
      let documents: Buffer[];
      try {
        documents = await scan(config.printerHost, request, caps);
      } finally {
        stopProgress();
      }
      const ext = format === "pdf" ? ".pdf" : ".jpg";
      const baseName = safeBaseName(args.filename ?? `scan-${timestamp()}`, ext);

      // One document is the normal case for PDF; JPEG returns one file per page.
      const saved: string[] = [];
      for (const [i, data] of documents.entries()) {
        const name = documents.length === 1
          ? baseName
          : baseName.replace(ext, `-${String(i + 1).padStart(2, "0")}${ext}`);
        saved.push(await saveScan(config.scanDir, name, data));
      }

      const urls = saved.map((f) =>
        downloadUrl(path.basename(f), {
          host: lanAddress(),
          port: config.port,
          token: config.token,
          scheme: config.tls ? "https" : "http",
        }));

      const lines = [
        `Scanned ${documents.length === 1 ? "1 document" : `${documents.length} files`} ` +
          `from the ${source === "flatbed" ? "flatbed glass" : "document feeder"} ` +
          `at ${request.resolution} dpi (${request.colorMode}).`,
        "",
        ...saved.map((f, i) => `Saved: ${f}\nDownload: ${urls[i]}`),
      ];

      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [];

      if (args.ocr) {
        const result = await ocrFile(saved[0]!, {
          languages: config.ocrLanguages,
          dpi: config.ocrDpi,
        });
        lines.push("");
        lines.push(
          result
            ? `OCR text (best-effort, may contain errors):\n\n${result.text}`
            : "OCR was requested but could not be run; the scanned file above is unaffected.",
        );
      }

      content.push({ type: "text", text: lines.join("\n") });

      const wantPreview = args.include_preview ?? saved.length === 1;
      if (wantPreview && saved.length >= 1) {
        const dir = await mkdtemp(path.join(tmpdir(), "printer-mcp-preview-"));
        try {
          const jpeg = await makePreview(saved[0]!, path.join(dir, "preview.jpg"));
          if (jpeg) {
            content.push({
              type: "image",
              data: jpeg.toString("base64"),
              mimeType: "image/jpeg",
            });
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }

      return { content };
    },
  );

  server.registerTool(
    "copy_document",
    {
      title: "Copy a document",
      description:
        "Use the printer as a photocopier: scan pages and print them straight back " +
        "out. Uses the document feeder by default. Pair source 'adf-duplex' with " +
        "sides 'two-sided-long-edge' to copy double-sided originals onto " +
        "double-sided pages. Nothing is kept on disk afterwards — use scan_document " +
        "if you want to keep a file.",
      inputSchema: {
        copies: z.number().int().min(1).max(99).optional()
          .describe("How many copies of each page. Defaults to 1."),
        source: sourceSchema.optional()
          .describe("Where to scan from. Defaults to 'adf', the document feeder."),
        color: z.enum(["color", "grayscale", "blackandwhite"]).optional()
          .describe("Colour mode for scanning and printing. Defaults to 'color'."),
        sides: z.enum(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]).optional()
          .describe("Whether the printed copies are single- or double-sided."),
        resolution: z.number().int().optional()
          .describe("Scan resolution in dpi. Defaults to 300, which suits copying."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const source = args.source ?? "adf";
      const colorMode = args.color ?? "color";

      await assertSourceReady(config.printerHost, source);

      const caps = await getCapabilities(config.printerHost);
      const stopProgress = startProgress(extra, "Copying");
      let documents: Buffer[];
      try {
        documents = await scan(config.printerHost, {
          source,
          format: "pdf",
          resolution: args.resolution ?? 300,
          colorMode,
        }, caps);
      } finally {
        stopProgress();
      }

      // A copy is transient: it goes to a temp file that is removed even if the print
      // fails, so copies never accumulate in the scan folder.
      const dir = await mkdtemp(path.join(tmpdir(), "printer-mcp-copy-"));
      try {
        const jobIds: string[] = [];
        for (const [i, data] of documents.entries()) {
          const file = path.join(dir, `copy-${i + 1}.pdf`);
          await writeFile(file, data);
          const { jobId } = await printFile(config.cupsDestination, file, {
            copies: args.copies,
            sides: args.sides,
            colorMode: colorMode === "color" ? "color" : "monochrome",
            title: "Copy",
          });
          if (jobId) jobIds.push(jobId);
        }

        const count = args.copies && args.copies > 1 ? `${args.copies} copies` : "1 copy";
        return {
          content: [{
            type: "text",
            text: `Copied from the ${source === "flatbed" ? "glass" : "document feeder"} ` +
              `and sent ${count} to the printer` +
              `${args.sides && args.sides !== "one-sided" ? ", double-sided" : ""}.` +
              (jobIds.length ? ` Job id: ${jobIds.join(", ")}` : ""),
          }],
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
