import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listDestinations, listJobs } from "../printer/cups.ts";
import { queryPrinterStatus } from "../printer/ipp.ts";
import { getScannerStatus, scanTransportInUse } from "../scanner/escl.ts";
import { diagnoseUnreachable } from "../scanner/diagnose.ts";
import { missingConfiguration, setupInstructions } from "../config.ts";
import type { Config } from "../config.ts";

function inkBar(percent: number): string {
  if (percent < 0) return "unknown";
  const filled = Math.round(percent / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${percent}%`;
}

export function registerStatusTools(server: McpServer, config: Config): void {
  server.registerTool(
    "get_device_status",
    {
      title: "Get printer and scanner status",
      description:
        "Report the current state of the HP OfficeJet Pro 9015e: printer state, ink " +
        "levels, loaded paper size, queued print jobs, and whether the scanner is idle " +
        "and has paper in its document feeder. Check this before scanning from the " +
        "feeder, and when a print or scan behaves unexpectedly.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      // An unconfigured install must not be reported as a broken printer.
      const missing = missingConfiguration(config);
      if (missing.length) {
        return { content: [{ type: "text", text: setupInstructions(missing) }] };
      }

      const [printer, jobs, destinations, scanner] = await Promise.all([
        queryPrinterStatus(config.printerHost).catch((e: Error) => e),
        listJobs().catch(() => []),
        listDestinations().catch(() => []),
        getScannerStatus(config.printerHost).catch((e: Error) => e),
      ]);

      const lines: string[] = [];

      if (printer instanceof Error) {
        lines.push(`Printer: unreachable (${printer.message})`);
      } else {
        lines.push(`Printer: ${printer.makeAndModel ?? "unknown"} — ${printer.state}`);
        if (printer.stateReasons.length) {
          lines.push(`  Attention: ${printer.stateReasons.join(", ")}`);
        }
        if (printer.stateMessage) lines.push(`  Message: ${printer.stateMessage}`);
        lines.push(`  Paper loaded: ${printer.mediaReady ?? "unknown"}`);
        if (printer.supplies.length) {
          lines.push("  Ink levels:");
          for (const s of printer.supplies) {
            lines.push(`    ${s.name.padEnd(18)} ${inkBar(s.levelPercent)}`);
          }
          const low = printer.supplies.filter((s) => s.levelPercent >= 0 && s.levelPercent <= 10);
          if (low.length) {
            lines.push(`  Low on ink: ${low.map((s) => s.name).join(", ")}`);
          }
        }
      }

      lines.push("");
      if (scanner instanceof Error) {
        const detail = scanner.message || (scanner as { code?: string }).code || "no details";
        lines.push(`Scanner: unreachable (${detail})`);
        // A bare connection error says nothing about the cause; work out whether the
        // printer is absent or this process is being denied the local network.
        const { hint } = await diagnoseUnreachable(config.printerHost);
        lines.push(...hint.split("\n").map((l) => `  ${l}`));
      } else {
        lines.push(`Scanner: ${scanner.state}`);
        if (scanTransportInUse() === "curl") {
          lines.push(
            "  (this process cannot open sockets to the printer, so scanning goes " +
            "through curl — working, but see the README on Local Network permission)",
          );
        }
        lines.push(
          `  Document feeder: ${
            scanner.adfLoaded
              ? "paper loaded, ready to scan"
              : `empty (${scanner.adfState ?? "no feeder reported"}) — ` +
                "load pages to use source 'adf', or use source 'flatbed' for the glass"
          }`,
        );
      }

      lines.push("");
      lines.push(
        jobs.length
          ? `Print queue: ${jobs.length} job(s)\n` +
            jobs.map((j) => `  ${j.id} — ${j.user}, ${j.sizeBytes} bytes, ${j.submittedAt}`)
              .join("\n")
          : "Print queue: empty",
      );

      if (destinations.length > 1) {
        lines.push("");
        lines.push(
          "Configured printers: " +
            destinations.map((d) => (d.isDefault ? `${d.name} (default)` : d.name)).join(", "),
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "cancel_print_job",
    {
      title: "Cancel a print job",
      description:
        "Cancel a queued or printing job by its job id. Job ids come from " +
        "get_device_status or from the result of a print tool, and look like " +
        "'HP_OfficeJet_Pro_9010_series__EXAMPLE_-254'.",
      inputSchema: { job_id: z.string().describe("The CUPS job id to cancel.") },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ job_id }) => {
      const { cancelJob } = await import("../printer/cups.ts");
      await cancelJob(job_id);
      return { content: [{ type: "text", text: `Cancelled print job ${job_id}.` }] };
    },
  );
}
