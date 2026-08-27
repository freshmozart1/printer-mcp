import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatusTools } from "./tools/status.ts";
import { registerPrintTools } from "./tools/print.ts";
import { registerScanTools } from "./tools/scan.ts";
import type { Config } from "./config.ts";

export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "printer-mcp", version: "0.1.0" },
    {
      instructions:
        "Controls an HP OfficeJet Pro 9015e on the local network: printing, scanning " +
        "and copying. Scanning defaults to the document feeder; check get_device_status " +
        "first if you are unsure whether paper is loaded. OCR text from scans is " +
        "best-effort and may contain recognition errors.",
    },
  );

  registerStatusTools(server, config);
  registerPrintTools(server, config);
  registerScanTools(server, config);
  return server;
}
