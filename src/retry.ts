/**
 * Retry helper for talking to a printer that goes to sleep.
 *
 * An idle OfficeJet drops off the network, its ARP entry expires, and the next
 * connection fails immediately with EHOSTUNREACH — the kernel cannot resolve the
 * device's MAC address. The attempt itself wakes the printer, so a retry a moment
 * later succeeds. Without this the first scan after an idle period fails with an
 * error that looks like a fault but is simply a sleeping device.
 */

/**
 * Text emitted by command line tools when they cannot reach the device.
 *
 * `ipptool` runs as a subprocess, so its failure arrives as a non-zero exit status
 * with the reason only in its output — none of the error codes below appear.
 */
const TRANSIENT_OUTPUT =
  /no route to host|unable to connect|host is down|network is unreachable/i;

/** Connection-level failures, raised before any request data reaches the device. */
const TRANSIENT = new Set([
  "EHOSTUNREACH", // no ARP entry — the classic sleeping-printer symptom
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ETIMEDOUT",
  "ECONNREFUSED", // seen briefly while the network stack comes back up
  "ECONNRESET",
  "EAI_AGAIN", // transient DNS/mDNS failure
]);

export function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT.has(code)) return true;

  // Happy Eyeballs reports every failed address together in an AggregateError.
  const nested = (error as { errors?: unknown }).errors;
  if (Array.isArray(nested)) return nested.some(isTransientNetworkError);

  // A failed subprocess carries its reason as text rather than a code.
  const text = [
    (error as { stderr?: unknown }).stderr,
    (error as { stdout?: unknown }).stdout,
    (error as { message?: unknown }).message,
  ].filter((v) => typeof v === "string").join("\n");
  return TRANSIENT_OUTPUT.test(text);
}

export interface RetryOptions {
  attempts?: number;
  /** Delay before each retry; the last value repeats if attempts exceed its length. */
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `operation`, retrying only connection-level failures.
 *
 * Safe for the scan-job POST as well as for reads: these errors mean the request
 * never reached the printer, so no job can have been created.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const delays = options.delaysMs ?? [400, 1200];
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientNetworkError(error)) throw error;
      options.onRetry?.(attempt, error);
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 1200);
    }
  }
  throw lastError;
}
