import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isTransientNetworkError, withRetry } from "../src/scanner/retry.ts";

const err = (code: string) => Object.assign(new Error(code), { code });
const noSleep = async () => {};

describe("isTransientNetworkError", () => {
  test("recognises a sleeping printer (EHOSTUNREACH)", () => {
    assert.equal(isTransientNetworkError(err("EHOSTUNREACH")), true);
  });

  test("recognises the other connection-level failures", () => {
    for (const code of ["EHOSTDOWN", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]) {
      assert.equal(isTransientNetworkError(err(code)), true, code);
    }
  });

  test("looks inside an AggregateError from Happy Eyeballs", () => {
    // Connecting by hostname tries several addresses and reports them together.
    const aggregate = new AggregateError([err("ECONNREFUSED"), err("EHOSTUNREACH")], "");
    assert.equal(isTransientNetworkError(aggregate), true);
  });

  test("does not treat an application error as transient", () => {
    assert.equal(isTransientNetworkError(new Error("Scanner rejected the job")), false);
    assert.equal(isTransientNetworkError(err("ENOENT")), false);
    assert.equal(isTransientNetworkError(undefined), false);
    assert.equal(isTransientNetworkError("EHOSTUNREACH"), false);
  });
});

describe("withRetry", () => {
  test("returns the result when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return "ok"; }, { sleep: noSleep });
    assert.equal(result, "ok");
    assert.equal(calls, 1, "must not retry a success");
  });

  test("recovers when a sleeping printer fails once then wakes", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw err("EHOSTUNREACH");
      return "awake";
    }, { sleep: noSleep });
    assert.equal(result, "awake");
    assert.equal(calls, 2);
  });

  test("gives up after the attempt limit and rethrows the last error", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; throw err("EHOSTUNREACH"); },
        { attempts: 3, sleep: noSleep }),
      /EHOSTUNREACH/);
    assert.equal(calls, 3);
  });

  test("does not retry an error that is not connection-level", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => { calls++; throw new Error("HTTP 500"); }, { sleep: noSleep }),
      /HTTP 500/);
    assert.equal(calls, 1, "a real failure must fail fast, not be retried");
  });

  test("backs off between attempts", async () => {
    const waited: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls < 3) throw err("EHOSTUNREACH");
      return "ok";
    }, { sleep: async (ms) => { waited.push(ms); }, delaysMs: [400, 1200] });
    assert.deepEqual(waited, [400, 1200]);
  });

  test("reports each retry so a caller can log it", async () => {
    const seen: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw err("EHOSTUNREACH");
      return "ok";
    }, { sleep: noSleep, onRetry: (attempt) => seen.push(attempt) });
    assert.deepEqual(seen, [1]);
  });
});
