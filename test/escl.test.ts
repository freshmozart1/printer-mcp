import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseScannerStatus, parseCapabilities, buildScanSettingsXml,
} from "../src/scanner/escl.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (n: string) => readFileSync(path.join(here, "fixtures", n), "utf8");

// Both fixtures are live captures from the OfficeJet Pro 9015e.
const capsXml = read("scanner-capabilities.xml");
const statusXml = read("scanner-status.xml");
const caps = parseCapabilities(capsXml);

describe("parseScannerStatus", () => {
  test("reads the scanner state and an empty feeder", () => {
    const status = parseScannerStatus(statusXml);
    assert.equal(status.state, "Idle");
    assert.equal(status.adfState, "ScannerAdfEmpty");
    assert.equal(status.adfLoaded, false);
  });

  test("reports a loaded feeder", () => {
    const loaded = statusXml.replace("ScannerAdfEmpty", "ScannerAdfLoaded");
    assert.equal(parseScannerStatus(loaded).adfLoaded, true);
  });

  test("treats a scanner with no ADF element as having no paper loaded", () => {
    const noAdf = statusXml.replace(/<scan:AdfState>.*<\/scan:AdfState>/, "");
    const status = parseScannerStatus(noAdf);
    assert.equal(status.adfState, undefined);
    assert.equal(status.adfLoaded, false);
  });
});

describe("parseCapabilities", () => {
  test("finds all three input sources", () => {
    assert.ok(caps.flatbed, "flatbed");
    assert.ok(caps.adf, "adf");
    assert.ok(caps["adf-duplex"], "adf-duplex");
  });

  test("reads per-source maximum scan dimensions in 1/300 inch units", () => {
    // The feeder takes longer pages (legal) than the glass.
    assert.equal(caps.flatbed!.maxWidth, 2550);
    assert.equal(caps.flatbed!.maxHeight, 3534);
    assert.equal(caps.adf!.maxHeight, 4200);
  });

  test("reads the supported resolutions", () => {
    assert.deepEqual(caps.flatbed!.resolutions, [75, 100, 150, 200, 300, 400, 600, 1200]);
  });

  test("reads the supported colour modes and document formats", () => {
    assert.deepEqual(caps.flatbed!.colorModes, ["BlackAndWhite1", "Grayscale8", "RGB24"]);
    assert.ok(caps.flatbed!.documentFormats.includes("application/pdf"));
    assert.ok(caps.flatbed!.documentFormats.includes("image/jpeg"));
  });
});

describe("buildScanSettingsXml", () => {
  const base = { format: "pdf", resolution: 300, colorMode: "color" } as const;

  test("maps the flatbed to the Platen input source without duplex", () => {
    const xml = buildScanSettingsXml({ ...base, source: "flatbed" }, caps);
    assert.match(xml, /<pwg:InputSource>Platen<\/pwg:InputSource>/);
    assert.match(xml, /<scan:Duplex>false<\/scan:Duplex>/);
  });

  test("maps the document feeder to Feeder, simplex by default", () => {
    const xml = buildScanSettingsXml({ ...base, source: "adf" }, caps);
    assert.match(xml, /<pwg:InputSource>Feeder<\/pwg:InputSource>/);
    assert.match(xml, /<scan:Duplex>false<\/scan:Duplex>/);
  });

  test("turns on duplex for adf-duplex", () => {
    const xml = buildScanSettingsXml({ ...base, source: "adf-duplex" }, caps);
    assert.match(xml, /<pwg:InputSource>Feeder<\/pwg:InputSource>/);
    assert.match(xml, /<scan:Duplex>true<\/scan:Duplex>/);
  });

  test("maps friendly colour names onto eSCL colour modes", () => {
    const m = (c: "color" | "grayscale" | "blackandwhite") =>
      buildScanSettingsXml({ ...base, source: "flatbed", colorMode: c }, caps);
    assert.match(m("color"), /<scan:ColorMode>RGB24</);
    assert.match(m("grayscale"), /<scan:ColorMode>Grayscale8</);
    assert.match(m("blackandwhite"), /<scan:ColorMode>BlackAndWhite1</);
  });

  test("maps the format onto a MIME type", () => {
    assert.match(buildScanSettingsXml({ ...base, source: "flatbed" }, caps),
      /<pwg:DocumentFormat>application\/pdf</);
    assert.match(buildScanSettingsXml({ ...base, source: "flatbed", format: "jpeg" }, caps),
      /<pwg:DocumentFormat>image\/jpeg</);
  });

  test("uses the source's full scan area as the region", () => {
    const xml = buildScanSettingsXml({ ...base, source: "adf" }, caps);
    assert.match(xml, /<pwg:Width>2550<\/pwg:Width>/);
    assert.match(xml, /<pwg:Height>4200<\/pwg:Height>/);
  });

  test("sets both resolution axes", () => {
    const xml = buildScanSettingsXml({ ...base, source: "flatbed", resolution: 600 }, caps);
    assert.match(xml, /<scan:XResolution>600</);
    assert.match(xml, /<scan:YResolution>600</);
  });

  test("rejects a resolution the scanner does not support", () => {
    assert.throws(
      () => buildScanSettingsXml({ ...base, source: "flatbed", resolution: 137 }, caps),
      /resolution.*137/i);
  });

  test("rejects a source the scanner does not have", () => {
    assert.throws(
      () => buildScanSettingsXml({ ...base, source: "adf" }, { flatbed: caps.flatbed }),
      /does not support/i);
  });

  test("produces well-formed XML with a declaration", () => {
    const xml = buildScanSettingsXml({ ...base, source: "flatbed" }, caps);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<\/scan:ScanSettings>\s*$/);
  });
});
