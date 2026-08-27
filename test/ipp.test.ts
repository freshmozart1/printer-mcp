import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeResponseAttributes, toPrinterStatus } from "../src/printer/ipp.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "printer-attrs.plist");

/** The fixture is a real ipptool -X capture from the OfficeJet Pro 9015e. */
function loadFixture(): Record<string, unknown> {
  const json = execFileSync("plutil", ["-convert", "json", "-o", "-", fixture]).toString();
  return mergeResponseAttributes(json);
}

describe("mergeResponseAttributes", () => {
  test("merges the response attribute groups into one object", () => {
    const attrs = loadFixture();
    assert.equal(attrs["printer-make-and-model"], "HP OfficeJet Pro 9010 series");
    // From the first group, proving both groups are merged rather than only the last.
    assert.equal(attrs["attributes-charset"], "utf-8");
  });

  test("throws a clear error when the IPP request itself failed", () => {
    const failed = JSON.stringify({
      Tests: [{ Successful: false, StatusCode: "client-error-not-found", ResponseAttributes: [] }],
    });
    assert.throws(() => mergeResponseAttributes(failed), /client-error-not-found/);
  });

  test("throws when there are no tests in the plist", () => {
    assert.throws(() => mergeResponseAttributes(JSON.stringify({ Tests: [] })), /no IPP response/i);
  });
});

describe("toPrinterStatus", () => {
  test("maps the numeric printer-state enum to a readable state", () => {
    assert.equal(toPrinterStatus(loadFixture()).state, "idle");
    assert.equal(toPrinterStatus({ "printer-state": 4 }).state, "processing");
    assert.equal(toPrinterStatus({ "printer-state": 5 }).state, "stopped");
    assert.equal(toPrinterStatus({ "printer-state": 99 }).state, "unknown");
  });

  test("pairs supply names, colors, types and levels together", () => {
    const supplies = toPrinterStatus(loadFixture()).supplies;
    assert.equal(supplies.length, 4);
    assert.deepEqual(supplies[0], {
      name: "cyan cartridge", color: "#00FFFF", type: "ink-cartridge", levelPercent: 50,
    });
    assert.deepEqual(supplies.map((s) => s.levelPercent), [50, 30, 30, 50]);
  });

  test("returns no supplies when the printer reports no marker attributes", () => {
    assert.deepEqual(toPrinterStatus({ "printer-state": 3 }).supplies, []);
  });

  test("normalises a single state reason into an array", () => {
    assert.deepEqual(toPrinterStatus({ "printer-state-reasons": "none" }).stateReasons, []);
    assert.deepEqual(
      toPrinterStatus({ "printer-state-reasons": ["media-jam", "cover-open"] }).stateReasons,
      ["media-jam", "cover-open"]);
  });

  test("reports the loaded media", () => {
    const status = toPrinterStatus(loadFixture());
    assert.equal(status.mediaReady, "iso_a4_210x297mm");
  });

  test("exposes the supported duplex modes so tool input can be validated", () => {
    const status = toPrinterStatus(loadFixture());
    assert.ok(status.sidesSupported.includes("two-sided-long-edge"));
  });
});
