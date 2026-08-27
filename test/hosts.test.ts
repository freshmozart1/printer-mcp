import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildAllowedHosts } from "../src/hosts.ts";

describe("buildAllowedHosts", () => {
  const base = {
    lanIp: "192.168.1.10",
    osHostname: "MacBookPro.fritz.box",
    localHostName: "MacBook-2",
  };

  test("lowercases every entry", () => {
    // The SDK matches case-sensitively against an already-lowercased URL hostname,
    // so a mixed-case entry silently rejects the host.
    const hosts = buildAllowedHosts(base);
    assert.deepEqual(hosts, hosts.map((h) => h.toLowerCase()));
    assert.ok(hosts.includes("macbookpro.fritz.box"));
  });

  test("includes the mDNS name, which differs from the OS hostname", () => {
    const hosts = buildAllowedHosts(base);
    assert.ok(hosts.includes("macbook-2.local"), "mDNS .local name");
    assert.ok(hosts.includes("macbook-2"), "bare mDNS name");
  });

  test("includes loopback, the LAN address and the short hostname", () => {
    const hosts = buildAllowedHosts(base);
    for (const expected of ["localhost", "127.0.0.1", "[::1]", "192.168.1.10", "macbookpro"]) {
      assert.ok(hosts.includes(expected), expected);
    }
  });

  test("appends extra hosts from configuration", () => {
    const hosts = buildAllowedHosts({ ...base, extra: ["Printer.example.COM"] });
    assert.ok(hosts.includes("printer.example.com"));
  });

  test("contains no duplicates or blanks", () => {
    const hosts = buildAllowedHosts({ ...base, osHostname: "MacBook-2", localHostName: "MacBook-2" });
    assert.equal(hosts.length, new Set(hosts).size, "duplicates present");
    assert.ok(!hosts.includes(""));
  });

  test("copes with no mDNS name available", () => {
    const hosts = buildAllowedHosts({ ...base, localHostName: undefined });
    assert.ok(hosts.includes("localhost"));
    assert.ok(hosts.includes("192.168.1.10"));
  });
});
