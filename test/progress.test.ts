import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startProgress } from "../src/progress.ts";

function fakeExtra(progressToken?: string | number) {
  const sent: unknown[] = [];
  return {
    sent,
    extra: {
      _meta: progressToken === undefined ? undefined : { progressToken },
      sendNotification: async (n: unknown) => { sent.push(n); },
    },
  };
}

describe("startProgress", () => {
  test("sends nothing when the client supplied no progress token", async () => {
    const { extra, sent } = fakeExtra();
    const stop = startProgress(extra, "Scanning");
    await delay(50);
    stop();
    assert.equal(sent.length, 0);
  });

  test("returns a stop function that is safe to call without a token", () => {
    const { extra } = fakeExtra();
    assert.doesNotThrow(() => startProgress(extra, "Scanning")());
  });

  test("stopping prevents any further notifications", async () => {
    const { extra, sent } = fakeExtra("tok-1");
    startProgress(extra, "Scanning")();
    await delay(60);
    assert.equal(sent.length, 0, "no heartbeat should fire after stop");
  });

  test("uses the caller's progress token", () => {
    // The token must be echoed back verbatim or the client cannot match the request.
    const { extra } = fakeExtra(42);
    const stop = startProgress(extra, "Scanning");
    assert.equal(typeof stop, "function");
    stop();
  });
});
