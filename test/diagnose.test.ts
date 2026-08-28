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

  test("does not blame the printer when the control itself may be blocked", async () => {
    // curl shares this process's restrictions, so a failing probe proves nothing about
    // the printer. Claiming it is switched off would be a guess presented as a fact.
    const d = await diagnoseUnreachable("192.168.1.50", async () => false);
    assert.equal(d.kind, "unknown");
    assert.doesNotMatch(d.hint, /Check that it is switched on/i);
    assert.match(d.hint, /cannot be told apart/i);
  });

  test("gives the reader a command that settles which cause it is", async () => {
    const d = await diagnoseUnreachable("192.168.1.50", async () => false);
    assert.match(d.hint, /curl -sk/);
    assert.match(d.hint, /200 means/);
    assert.match(d.hint, /PRINTER_MCP_PRINTER_HOST/);
  });

  test("says the grant may be needed on node rather than the app", async () => {
    // A launcher that disclaims its children does not pass its own grant down.
    const d = await diagnoseUnreachable("192.168.1.50", async () => false);
    assert.match(d.hint, /node/);
    assert.match(d.hint, /disclaims/i);
  });

  test("includes the host being diagnosed in both cases", async () => {
    for (const reachable of [true, false]) {
      const d = await diagnoseUnreachable("10.1.2.3", async () => reachable);
      assert.match(d.hint, /10\.1\.2\.3/);
    }
  });

  test("never throws, since it runs on an error path already", async () => {
    const d = await diagnoseUnreachable("192.168.1.50", async () => {
      throw new Error("curl exploded");
    });
    assert.equal(d.kind, "unknown");
    assert.ok(d.hint.length > 0);
  });
});
