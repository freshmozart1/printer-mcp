import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig, missingConfiguration, setupInstructions, assertConfigured,
  PLACEHOLDER_PRINTER_HOST, PLACEHOLDER_CUPS_DEST,
} from "../src/config.ts";

const unconfigured = () => loadConfig({
  PRINTER_MCP_PRINTER_HOST: PLACEHOLDER_PRINTER_HOST,
  PRINTER_MCP_CUPS_DEST: PLACEHOLDER_CUPS_DEST,
} as NodeJS.ProcessEnv);

const configured = () => loadConfig({
  PRINTER_MCP_PRINTER_HOST: "192.168.1.50",
  PRINTER_MCP_CUPS_DEST: "My_Printer",
} as NodeJS.ProcessEnv);

describe("detecting an unconfigured install", () => {
  test("reports both settings when neither is set", () => {
    assert.deepEqual(missingConfiguration(unconfigured()),
      ["PRINTER_MCP_PRINTER_HOST", "PRINTER_MCP_CUPS_DEST"]);
  });

  test("reports nothing once both are set", () => {
    assert.deepEqual(missingConfiguration(configured()), []);
  });

  test("reports only the setting still missing", () => {
    const partial = loadConfig({
      PRINTER_MCP_PRINTER_HOST: "192.168.1.50",
      PRINTER_MCP_CUPS_DEST: PLACEHOLDER_CUPS_DEST,
    } as NodeJS.ProcessEnv);
    assert.deepEqual(missingConfiguration(partial), ["PRINTER_MCP_CUPS_DEST"]);
  });
});

describe("setupInstructions", () => {
  test("names the variables and the file to put them in", () => {
    const text = setupInstructions(["PRINTER_MCP_PRINTER_HOST", "PRINTER_MCP_CUPS_DEST"]);
    assert.match(text, /PRINTER_MCP_PRINTER_HOST/);
    assert.match(text, /PRINTER_MCP_CUPS_DEST/);
    assert.match(text, /\.config\/printer-mcp\/env/);
    assert.match(text, /lpstat -p/);
  });

  test("does not advise checking a printer that is not the problem", () => {
    // The failure here is missing configuration, not a device that is switched off.
    const text = setupInstructions(["PRINTER_MCP_PRINTER_HOST"]);
    assert.doesNotMatch(text, /switched on/i);
    assert.doesNotMatch(text, /DHCP/i);
  });

  test("mentions only the setting that is actually missing", () => {
    const text = setupInstructions(["PRINTER_MCP_CUPS_DEST"]);
    assert.doesNotMatch(text, /PRINTER_MCP_PRINTER_HOST=/);
  });
});

describe("assertConfigured", () => {
  test("throws the setup message when unconfigured", () => {
    assert.throws(() => assertConfigured(unconfigured()), /has not been pointed at a printer/);
  });

  test("passes once configured", () => {
    assert.doesNotThrow(() => assertConfigured(configured()));
  });
});
