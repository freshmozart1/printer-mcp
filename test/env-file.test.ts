import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile, loadConfig } from "../src/config.ts";

async function withEnvFile(contents: string, fn: (file: string) => void | Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "printer-mcp-env-"));
  const file = path.join(dir, "env");
  await writeFile(file, contents);
  try { await fn(file); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("loadEnvFile", () => {
  test("reads KEY=VALUE pairs", async () => {
    await withEnvFile("PRINTER_MCP_PRINTER_HOST=192.168.1.50\nPRINTER_MCP_PORT=9000\n", (f) => {
      assert.deepEqual(loadEnvFile(f), {
        PRINTER_MCP_PRINTER_HOST: "192.168.1.50",
        PRINTER_MCP_PORT: "9000",
      });
    });
  });

  test("ignores comments and blank lines", async () => {
    await withEnvFile("# a comment\n\n  \nPRINTER_MCP_PORT=1\n", (f) => {
      assert.deepEqual(loadEnvFile(f), { PRINTER_MCP_PORT: "1" });
    });
  });

  test("strips surrounding quotes so values with spaces survive", async () => {
    await withEnvFile('A="two words"\nB=\'single\'\n', (f) => {
      assert.equal(loadEnvFile(f).A, "two words");
      assert.equal(loadEnvFile(f).B, "single");
    });
  });

  test("keeps '=' inside a value", async () => {
    await withEnvFile("PRINTER_MCP_TOKEN=abc=def==\n", (f) => {
      assert.equal(loadEnvFile(f).PRINTER_MCP_TOKEN, "abc=def==");
    });
  });

  test("skips malformed lines rather than throwing", async () => {
    await withEnvFile("no_equals_here\n=novalue\nGOOD=1\n", (f) => {
      assert.deepEqual(loadEnvFile(f), { GOOD: "1" });
    });
  });

  test("returns nothing when the file does not exist", () => {
    assert.deepEqual(loadEnvFile("/nonexistent/printer-mcp/env"), {});
  });
});

describe("loadConfig precedence", () => {
  test("a real environment variable overrides the file", () => {
    // The file supplies defaults; an explicit variable must still win.
    const config = loadConfig({ PRINTER_MCP_PRINTER_HOST: "10.0.0.5" } as NodeJS.ProcessEnv);
    assert.equal(config.printerHost, "10.0.0.5");
  });

  test("falls back to the built-in default when nothing is set", () => {
    const config = loadConfig({ PRINTER_MCP_PORT: "1234" } as NodeJS.ProcessEnv);
    assert.equal(config.port, 1234);
    assert.ok(config.printerHost.length > 0);
  });
});
