import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { markdownToBlocks, textToBlocks, renderToPdf } from "../src/render/textToPdf.ts";
import type { Block } from "../src/render/textToPdf.ts";

const plain = (b: Block) => ("spans" in b ? b.spans.map((s) => s.text).join("") : "");

describe("markdownToBlocks", () => {
  test("converts headings with their level", () => {
    const blocks = markdownToBlocks("# Title\n\n## Sub\n\n### Deep\n");
    assert.deepEqual(blocks.map((b) => b.type), ["heading", "heading", "heading"]);
    assert.deepEqual(blocks.map((b) => (b as { level: number }).level), [1, 2, 3]);
    assert.equal(plain(blocks[0]!), "Title");
  });

  test("converts paragraphs", () => {
    const blocks = markdownToBlocks("Hello world.\n\nSecond para.\n");
    assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "paragraph"]);
    assert.equal(plain(blocks[1]!), "Second para.");
  });

  test("marks bold and italic spans", () => {
    const [block] = markdownToBlocks("Normal **bold** and *italic* text.");
    const spans = (block as { spans: { text: string; bold?: boolean; italic?: boolean }[] }).spans;
    assert.equal(spans.find((s) => s.text === "bold")?.bold, true);
    assert.equal(spans.find((s) => s.text === "italic")?.italic, true);
    assert.equal(spans.find((s) => s.text === "Normal ")?.bold, undefined);
  });

  test("converts bullet and ordered lists, numbering ordered items", () => {
    const bullets = markdownToBlocks("- one\n- two\n");
    assert.deepEqual(bullets.map((b) => b.type), ["listItem", "listItem"]);
    assert.equal((bullets[0] as { ordered: boolean }).ordered, false);

    const ordered = markdownToBlocks("1. first\n2. second\n");
    assert.equal((ordered[0] as { ordered: boolean; index: number }).ordered, true);
    assert.equal((ordered[0] as { index: number }).index, 1);
    assert.equal((ordered[1] as { index: number }).index, 2);
  });

  test("keeps fenced code blocks verbatim", () => {
    const [block] = markdownToBlocks("```\nline1\nline2\n```\n");
    assert.equal(block!.type, "code");
    assert.equal((block as { text: string }).text, "line1\nline2\n");
  });

  test("converts blockquotes and horizontal rules", () => {
    assert.equal(markdownToBlocks("> quoted\n")[0]!.type, "quote");
    assert.ok(markdownToBlocks("---\n").some((b) => b.type === "rule"));
  });

  test("renders inline code as a code span", () => {
    const [block] = markdownToBlocks("run `npm test` now");
    const spans = (block as { spans: { text: string; code?: boolean }[] }).spans;
    assert.equal(spans.find((s) => s.text === "npm test")?.code, true);
  });

  test("returns no blocks for empty input", () => {
    assert.deepEqual(markdownToBlocks(""), []);
  });
});

describe("textToBlocks", () => {
  test("treats blank-line-separated chunks as paragraphs without parsing markdown", () => {
    const blocks = textToBlocks("First line\nstill first.\n\n# not a heading\n");
    assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "paragraph"]);
    // The '#' must survive literally rather than becoming a heading.
    assert.equal(plain(blocks[1]!), "# not a heading");
  });

  test("returns no blocks for whitespace only", () => {
    assert.deepEqual(textToBlocks("   \n\n  "), []);
  });
});

describe("renderToPdf", () => {
  test("produces a valid PDF from markdown", async () => {
    const pdf = await renderToPdf("# Report\n\nBody **text**.\n", { markdown: true });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 500);
  });

  test("produces a valid PDF from plain text", async () => {
    const pdf = await renderToPdf("just some text", { markdown: false });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });

  test("rejects empty content rather than printing a blank sheet", async () => {
    await assert.rejects(() => renderToPdf("   ", { markdown: true }), /empty/i);
  });

  test("paginates long content across multiple pages", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph number ${i}.`).join("\n\n");
    const pdf = await renderToPdf(long, { markdown: false });
    // Each page object appears as "/Type /Page" in the PDF body.
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    assert.ok(pages > 1, `expected multiple pages, got ${pages}`);
  });
});
