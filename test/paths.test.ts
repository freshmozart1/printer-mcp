import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveAllowedPath } from "../src/config.ts";

let root: string;
let allowedDir: string;
let allowed: string[];

before(async () => {
  // realpath the temp root: on macOS /var is a symlink to /private/var, and the
  // allowlist compares realpaths.
  root = await mkdtemp(path.join(tmpdir(), "printer-mcp-paths-"));
  const { realpath } = await import("node:fs/promises");
  root = await realpath(root);

  allowedDir = path.join(root, "Documents");
  await mkdir(path.join(allowedDir, "nested"), { recursive: true });
  await mkdir(path.join(root, "Documents-secret"), { recursive: true });
  await mkdir(path.join(root, "secrets"), { recursive: true });

  await writeFile(path.join(allowedDir, "ok.pdf"), "x");
  await writeFile(path.join(allowedDir, "nested", "deep.pdf"), "x");
  await writeFile(path.join(root, "Documents-secret", "sneaky.pdf"), "x");
  await writeFile(path.join(root, "secrets", "id_rsa"), "x");

  // A symlink living inside the allowed dir but pointing outside it.
  await symlink(path.join(root, "secrets", "id_rsa"), path.join(allowedDir, "link.pdf"));

  allowed = [allowedDir];
});

after(async () => { await rm(root, { recursive: true, force: true }); });

describe("resolveAllowedPath", () => {
  test("accepts a file directly inside an allowed directory", async () => {
    const p = await resolveAllowedPath(path.join(allowedDir, "ok.pdf"), allowed);
    assert.equal(p, path.join(allowedDir, "ok.pdf"));
  });

  test("accepts a file in a nested subdirectory", async () => {
    const p = await resolveAllowedPath(path.join(allowedDir, "nested", "deep.pdf"), allowed);
    assert.equal(p, path.join(allowedDir, "nested", "deep.pdf"));
  });

  test("expands a leading ~ to the home directory", async () => {
    const { homedir } = await import("node:os");
    // The error names the resolved path, which proves ~ was expanded rather than
    // treated as a literal directory name.
    await assert.rejects(
      () => resolveAllowedPath("~/definitely-missing-xyz.pdf", allowed),
      (err: Error) => err.message.includes(path.join(homedir(), "definitely-missing-xyz.pdf")),
    );
  });

  test("rejects a file outside every allowed directory", async () => {
    await assert.rejects(
      () => resolveAllowedPath(path.join(root, "secrets", "id_rsa"), allowed),
      /outside the allowed/i);
  });

  test("rejects ../ traversal that escapes the allowed directory", async () => {
    await assert.rejects(
      () => resolveAllowedPath(path.join(allowedDir, "..", "secrets", "id_rsa"), allowed),
      /outside the allowed/i);
  });

  test("rejects a sibling directory sharing the allowed dir's name prefix", async () => {
    // Documents-secret must not pass a naive startsWith("Documents") check.
    await assert.rejects(
      () => resolveAllowedPath(path.join(root, "Documents-secret", "sneaky.pdf"), allowed),
      /outside the allowed/i);
  });

  test("rejects a symlink inside the allowed dir that points outside it", async () => {
    await assert.rejects(
      () => resolveAllowedPath(path.join(allowedDir, "link.pdf"), allowed),
      /outside the allowed/i);
  });

  test("rejects a path that does not exist", async () => {
    await assert.rejects(
      () => resolveAllowedPath(path.join(allowedDir, "nope.pdf"), allowed),
      /not found/i);
  });

  test("rejects a directory, since only files can be printed", async () => {
    await assert.rejects(
      () => resolveAllowedPath(path.join(allowedDir, "nested"), allowed),
      /not a file/i);
  });

  test("rejects when the allowlist is empty", async () => {
    await assert.rejects(
      () => resolveAllowedPath(path.join(allowedDir, "ok.pdf"), []),
      /outside the allowed/i);
  });
});
