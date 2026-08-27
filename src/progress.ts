/**
 * Progress heartbeats for long-running operations.
 *
 * Scanning a full document feeder can take several minutes, while MCP clients commonly
 * default to a 60 second request timeout. A client that receives progress notifications
 * resets that timeout, so without these a long scan is abandoned by the caller even
 * though the scanner completes it and the file is written.
 */

interface ProgressCapableExtra {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

const HEARTBEAT_MS = 10_000;

/**
 * Begin sending periodic progress notifications. Returns a function that stops them;
 * always call it in a `finally` block.
 *
 * Does nothing when the client did not supply a progress token, which is the signal
 * that it is not interested in progress.
 */
export function startProgress(extra: ProgressCapableExtra, message: string): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => {};

  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    // Indeterminate progress: the scanner does not tell us how many pages are coming.
    void extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: ticks,
        message: `${message} (${ticks * (HEARTBEAT_MS / 1000)}s)`,
      },
    }).catch(() => {});
  }, HEARTBEAT_MS);

  timer.unref?.();
  return () => clearInterval(timer);
}
