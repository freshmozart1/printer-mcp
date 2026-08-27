import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ocrFile, isOcrAvailable } from "../src/ocr/index.ts";
import { renderToPdf } from "../src/render/textToPdf.ts";

describe("ocrFile", () => {
  test("the native helper has been built", () => {
    assert.equal(isOcrAvailable(), true, "run `npm run build:ocr`");
  });

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
