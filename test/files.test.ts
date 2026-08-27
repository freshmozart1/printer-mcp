import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { safeBaseName, signName, verifyName, downloadUrl } from "../src/files.ts";

describe("safeBaseName", () => {
  test("keeps a reasonable name and adds the extension when missing", () => {
    assert.equal(safeBaseName("invoice", ".pdf"), "invoice.pdf");
    assert.equal(safeBaseName("invoice.pdf", ".pdf"), "invoice.pdf");
  });

  test("strips directory components so a scan cannot escape the scan folder", () => {
    assert.equal(safeBaseName("../../etc/passwd", ".pdf"), "passwd.pdf");
    assert.equal(safeBaseName("/etc/shadow", ".pdf"), "shadow.pdf");
  });

  test("replaces characters that could confuse a shell or filesystem", () => {
    assert.equal(safeBaseName("my scan;rm -rf.pdf", ".pdf"), "my-scan-rm-rf.pdf");
  });

  test("falls back to a timestamped name when nothing usable remains", () => {
    assert.match(safeBaseName("...", ".pdf"), /^scan-.*\.pdf$/);
    assert.match(safeBaseName("", ".pdf"), /^scan-.*\.pdf$/);
  });
});

describe("download link signing", () => {
  const token = "secret-token";

  test("accepts a signature it produced", () => {
    assert.equal(verifyName("a.pdf", signName("a.pdf", token), token), true);
  });

  test("rejects a signature for a different file", () => {
    assert.equal(verifyName("b.pdf", signName("a.pdf", token), token), false);
  });

  test("rejects a signature made with a different token", () => {
    assert.equal(verifyName("a.pdf", signName("a.pdf", "other"), token), false);
  });

  test("rejects a missing or malformed signature", () => {
    assert.equal(verifyName("a.pdf", "", token), false);
    assert.equal(verifyName("a.pdf", "abc", token), false);
  });

  test("the URL carries a signature and never the token itself", () => {
    const url = downloadUrl("a b.pdf", { host: "192.168.1.5", port: 8765, token });
    assert.match(url, /^http:\/\/192\.168\.1\.5:8765\/files\/a%20b\.pdf\?sig=[0-9a-f]{32}$/);
    assert.ok(!url.includes(token));
  });
});
