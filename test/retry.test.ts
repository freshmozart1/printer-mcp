import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isTransientNetworkError, withRetry } from "../src/retry.ts";

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

describe("isTransientNetworkError on subprocess failures", () => {
  // ipptool exits non-zero with the reason only in its output; none of the error
  // codes appear, so the text has to be recognised instead.
  const execFailure = (stderr: string) =>
    Object.assign(new Error(`Command failed: ipptool ...\n${stderr}`), { code: 1, stderr });

  test("recognises a sleeping printer reported by ipptool", () => {
    assert.equal(isTransientNetworkError(execFailure(
      'ipptool: Unable to connect to "192.168.1.50" on port 631 - No route to host')), true);
  });

  test("recognises the other unreachable phrasings", () => {
    for (const t of ["Host is down", "Network is unreachable", "Unable to connect to host"]) {
      assert.equal(isTransientNetworkError(execFailure(t)), true, t);
    }
  });

  test("does not retry a genuine IPP error", () => {
    // A printer that answers with an error is not a transient condition.
    assert.equal(isTransientNetworkError(execFailure("successful-ok not returned")), false);
    assert.equal(isTransientNetworkError(execFailure("client-error-not-found")), false);
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
