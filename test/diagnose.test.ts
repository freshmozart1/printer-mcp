import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { diagnoseUnreachable } from "../src/scanner/diagnose.ts";

describe("diagnoseUnreachable", () => {
  test("blames the process when other programs can reach the printer", async () => {
    // curl gets through but our socket did not: the network is fine, we are blocked.
    const d = await diagnoseUnreachable("192.168.1.50", async () => true);
    assert.equal(d.kind, "process-blocked");
    assert.match(d.hint, /Local Network/);
    assert.match(d.hint, /Privacy & Security/);
  });

  test("names the firewall possibility too", async () => {
    const d = await diagnoseUnreachable("192.168.1.50", async () => true);
    assert.match(d.hint, /LuLu|Little Snitch/);
  });

  test("blames the printer or its address when nothing can reach it", async () => {
    const d = await diagnoseUnreachable("192.168.1.50", async () => false);
    assert.equal(d.kind, "host-unreachable");
    assert.match(d.hint, /switched\s+on/);
    assert.match(d.hint, /PRINTER_MCP_PRINTER_HOST/);
  });

  test("includes the host being diagnosed in both cases", async () => {
    for (const reachable of [true, false]) {
      const d = await diagnoseUnreachable("10.1.2.3", async () => reachable);
      assert.match(d.hint, /10\.1\.2\.3/);
    }
  });

  test("never throws, since it runs on an error path already", async () => {
    // If diagnosis could throw it would replace a useful message with a crash.
    const d = await diagnoseUnreachable("192.168.1.50", async () => {
      throw new Error("curl exploded");
    });
    assert.equal(d.kind, "host-unreachable");
    assert.ok(d.hint.length > 0);
  });
});
