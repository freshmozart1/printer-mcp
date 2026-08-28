import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTransport, isBlockedByPolicy, parseCurlHeaders, curlRequest } from "../src/scanner/transport.ts";
import type { HttpResult } from "../src/scanner/transport.ts";

const ok: HttpResult = { status: 200, headers: {}, body: Buffer.from("ok") };
const err = (code: string) => Object.assign(new Error(code), { code });

describe("parseCurlHeaders", () => {
  test("reads the status line and headers", () => {
    const { status, headers } = parseCurlHeaders(
      "HTTP/1.1 201 Created\r\nLocation: https://p/eSCL/ScanJobs/1\r\nContent-Type: text/xml\r\n\r\n");
    assert.equal(status, 201);
    assert.equal(headers.location, "https://p/eSCL/ScanJobs/1");
    assert.equal(headers["content-type"], "text/xml");
  });

  test("lowercases header names so lookups match Node's", () => {
    assert.equal(parseCurlHeaders("HTTP/1.1 200 OK\r\nLOCATION: x\r\n\r\n").headers.location, "x");
  });

  test("uses the final response when curl reports several", () => {
    // A 100-continue or redirect emits more than one header block.
    const dump = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nLocation: /job/9\r\n\r\n";
    const { status, headers } = parseCurlHeaders(dump);
    assert.equal(status, 201);
    assert.equal(headers.location, "/job/9");
  });

  test("copes with an empty dump", () => {
    assert.deepEqual(parseCurlHeaders(""), { status: 0, headers: {} });
  });
});

describe("isBlockedByPolicy", () => {
  test("recognises the permission-denied family", () => {
    for (const c of ["EHOSTUNREACH", "EBADF", "ENETUNREACH", "EPERM", "EACCES"]) {
      assert.equal(isBlockedByPolicy(err(c)), true, c);
    }
  });

  test("looks inside an AggregateError", () => {
    assert.equal(isBlockedByPolicy(new AggregateError([err("EHOSTUNREACH")], "")), true);
  });

  test("ignores unrelated failures", () => {
    assert.equal(isBlockedByPolicy(err("ECONNREFUSED")), false);
    assert.equal(isBlockedByPolicy(new Error("HTTP 500")), false);
  });
});

describe("createTransport", () => {
  test("uses Node when nothing is blocked", async () => {
    let nodeCalls = 0, curlCalls = 0;
    const t = createTransport("auto", {
      node: async () => { nodeCalls++; return ok; },
      curl: async () => { curlCalls++; return ok; },
    });
    await t("https://p/eSCL/ScannerStatus");
    assert.equal(nodeCalls, 1);
    assert.equal(curlCalls, 0);
    assert.equal(t.current(), "node");
  });

  test("falls back to curl when the process is blocked", async () => {
    let curlCalls = 0;
    const t = createTransport("auto", {
      node: async () => { throw err("EHOSTUNREACH"); },
      curl: async () => { curlCalls++; return ok; },
    });
    const result = await t("https://p/eSCL/ScannerStatus");
    assert.equal(result.status, 200);
    assert.equal(curlCalls, 1);
    assert.equal(t.current(), "curl");
  });

  test("remembers the fallback instead of retrying Node every time", async () => {
    let nodeCalls = 0, curlCalls = 0;
    const t = createTransport("auto", {
      node: async () => { nodeCalls++; throw err("EHOSTUNREACH"); },
      curl: async () => { curlCalls++; return ok; },
    });
    await t("https://p/a");
    await t("https://p/b");
    await t("https://p/c");
    assert.equal(nodeCalls, 1, "Node should be tried once, not on every request");
    assert.equal(curlCalls, 3);
  });

  test("reports the fallback so it is visible in the log", async () => {
    let told = false;
    const t = createTransport("auto", {
      node: async () => { throw err("EHOSTUNREACH"); },
      curl: async () => ok,
      onFallback: () => { told = true; },
    });
    await t("https://p/a");
    assert.equal(told, true);
  });

  test("does not fall back for an unrelated error", async () => {
    let curlCalls = 0;
    const t = createTransport("auto", {
      node: async () => { throw new Error("Scanner rejected the job"); },
      curl: async () => { curlCalls++; return ok; },
    });
    await assert.rejects(() => t("https://p/a"), /rejected the job/);
    assert.equal(curlCalls, 0, "a real error must surface, not be masked by a fallback");
  });

  test("mode 'curl' skips Node entirely", async () => {
    let nodeCalls = 0;
    const t = createTransport("curl", {
      node: async () => { nodeCalls++; return ok; },
      curl: async () => ok,
    });
    await t("https://p/a");
    assert.equal(nodeCalls, 0);
    assert.equal(t.current(), "curl");
  });

  test("mode 'node' never falls back", async () => {
    const t = createTransport("node", {
      node: async () => { throw err("EHOSTUNREACH"); },
      curl: async () => ok,
    });
    await assert.rejects(() => t("https://p/a"), /EHOSTUNREACH/);
  });
});

// Touches real hardware, so it runs only when a printer has actually been configured.
// A fresh clone leaves the placeholder default in place and skips, which keeps
// `npm test` free of any device dependency.
const { loadConfig } = await import("../src/config.ts");
const configuredHost = loadConfig().printerHost;
const haveRealPrinter = !configuredHost.startsWith("HPEXAMPLE");

describe("curlRequest against the real printer", {
  skip: haveRealPrinter ? false : "no printer configured (set PRINTER_MCP_PRINTER_HOST)",
}, () => {
  test("fetches scanner status", async () => {
    const res = await curlRequest(`https://${configuredHost}/eSCL/ScannerStatus`,
      { timeoutMs: 10_000 });
    assert.equal(res.status, 200);
    assert.match(res.body.toString("utf8"), /ScannerStatus/);
  });
});
