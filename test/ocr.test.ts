import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ocrFile, isOcrAvailable } from "../src/ocr/index.ts";
import { renderToPdf } from "../src/render/textToPdf.ts";

// OCR is optional: without the Xcode command line tools the helper is never built,
// and the server is expected to run without it. Skip rather than fail there.
describe("ocrFile", { skip: !isOcrAvailable() && "native/ocr not built" }, () => {
  test("reads text back out of a generated PDF", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "printer-mcp-ocr-"));
    try {
      const file = path.join(dir, "doc.pdf");
      // Large, proportional text is the realistic case for a scanned document.
      await writeFile(file, await renderToPdf("# Invoice Total\n\nAmount due today\n",
        { markdown: true }));

      const result = await ocrFile(file, { languages: ["en-US"], dpi: 200 });
      assert.ok(result, "expected an OCR result");
      assert.equal(result!.pages.length, 1);
      // OCR is best-effort, so assert on distinctive words rather than an exact match.
      assert.match(result!.text, /Invoice/i);
      assert.match(result!.text, /Amount/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined for a file it cannot read instead of throwing", async () => {
    assert.equal(await ocrFile("/nonexistent/nope.pdf"), undefined);
  });
});

describe("ocrFile without the native helper", () => {
  test("reports OCR as unavailable rather than throwing", async () => {
    // Mirrors a machine with no Xcode: the scan must still succeed, just without text.
    const { ocrFile: ocr } = await import("../src/ocr/index.ts");
    assert.equal(typeof isOcrAvailable(), "boolean");
    assert.equal(await ocr("/nonexistent/file.pdf"), undefined);
  });
});
