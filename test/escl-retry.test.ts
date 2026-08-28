import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getScannerStatus } from "../src/scanner/escl.ts";

const certDir = path.join(homedir(), ".config", "printer-mcp");
const key = path.join(certDir, "key.pem");
const cert = path.join(certDir, "cert.pem");

const STATUS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerStatus xmlns:scan="x" xmlns:pwg="y">
  <pwg:State>Idle</pwg:State><scan:AdfState>ScannerAdfLoaded</scan:AdfState>
</scan:ScannerStatus>`;

describe("eSCL client retries a printer that is not answering yet", { skip: !existsSync(cert) }, () => {
  test("recovers when the first connection is refused", async () => {
    // Stands in for a sleeping printer: the first attempt fails instantly, and the
    // device is reachable by the time the retry goes out.
    const port = 19443;
    const request = getScannerStatus(`127.0.0.1:${port}`);

    const server = createServer(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (_req, res) => { res.writeHead(200, { "Content-Type": "text/xml" }); res.end(STATUS_XML); },
    );
    // Start listening only after the first attempt has already been refused.
    await new Promise((r) => setTimeout(r, 150));
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));

    try {
      const status = await request;
      assert.equal(status.state, "Idle");
      assert.equal(status.adfLoaded, true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
