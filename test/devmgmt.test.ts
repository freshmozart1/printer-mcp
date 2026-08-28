import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseStatusCategories, parseConsumables, toPrinterStatus } from "../src/printer/devmgmt.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (n: string) => readFileSync(path.join(here, "fixtures", n), "utf8");

// Live captures from the printer's own HTTP endpoints.
const statusXml = read("hp-status.xml");
const consumablesXml = read("hp-consumables.xml");

describe("parseStatusCategories", () => {
  test("reads the categories the printer reports", () => {
    const c = parseStatusCategories(statusXml);
    assert.ok(c.includes("inPowerSave"), "expected the power-save category");
  });
});

describe("parseConsumables", () => {
  test("reads a level for each of the four inks", () => {
    const s = parseConsumables(consumablesXml);
    assert.equal(s.length, 4, "four inks, printhead excluded");
    assert.deepEqual(s.map((x) => x.levelPercent), [50, 30, 30, 50]);
  });

  test("names and colours the cartridges", () => {
    const s = parseConsumables(consumablesXml);
    assert.deepEqual(s.map((x) => x.name),
      ["cyan cartridge", "magenta cartridge", "yellow cartridge", "black cartridge"]);
    assert.equal(s[0]!.color, "#00FFFF");
    assert.equal(s[3]!.color, "#000000");
  });

  test("excludes the printhead, which holds no ink", () => {
    // It appears as a ConsumableInfo block but is type "printhead".
    assert.ok(!parseConsumables(consumablesXml).some((s) => s.name.includes("CMYK")));
  });

  test("returns nothing for an empty document", () => {
    assert.deepEqual(parseConsumables("<x/>"), []);
  });
});

describe("toPrinterStatus", () => {
  test("treats power save as idle, not a fault", () => {
    // A sleeping printer is working normally.
    const s = toPrinterStatus(statusXml, consumablesXml);
    assert.equal(s.state, "idle");
    assert.deepEqual(s.stateReasons, []);
  });

  test("matches the ink levels IPP reports", () => {
    assert.deepEqual(
      toPrinterStatus(statusXml, consumablesXml).supplies.map((s) => s.levelPercent),
      [50, 30, 30, 50]);
  });

  test("surfaces a real fault as a state reason", () => {
    const jam = '<a><pscat:StatusCategory>mediaJam</pscat:StatusCategory></a>';
    const s = toPrinterStatus(jam, "<x/>");
    assert.equal(s.state, "stopped");
    assert.deepEqual(s.stateReasons, ["mediaJam"]);
  });

  test("reports processing while printing", () => {
    const busy = '<a><pscat:StatusCategory>processing</pscat:StatusCategory></a>';
    assert.equal(toPrinterStatus(busy, "<x/>").state, "processing");
  });

  test("reports no media, which this endpoint does not provide", () => {
    assert.equal(toPrinterStatus(statusXml, consumablesXml).mediaReady, undefined);
  });
});
