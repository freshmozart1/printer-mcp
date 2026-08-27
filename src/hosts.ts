import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

/**
 * Build the Host header allowlist used for DNS-rebinding protection.
 *
 * Every entry is lowercased: the validator compares against `new URL(...).hostname`,
 * which lowercases, using a case-sensitive match. A mixed-case entry such as
 * "MacBookPro.fritz.box" would therefore never match and the host would be rejected.
 */
export function buildAllowedHosts(input: {
  lanIp: string;
  osHostname: string;
  /** macOS mDNS name, which often differs from the OS hostname. */
  localHostName?: string | undefined;
  extra?: string[] | undefined;
}): string[] {
  const short = input.osHostname.split(".")[0] ?? "";
  const names = [
    "localhost",
    "127.0.0.1",
    "[::1]",
    input.lanIp,
    input.osHostname,
    short,
    short ? `${short}.local` : "",
    input.localHostName ?? "",
    input.localHostName ? `${input.localHostName}.local` : "",
    ...(input.extra ?? []),
  ];

  return [...new Set(
    names.map((n) => n.trim().toLowerCase()).filter(Boolean),
  )];
}

/** The machine's mDNS name, which on macOS often differs from `os.hostname()`. */
export function localHostName(): string | undefined {
  try {
    return execFileSync("scutil", ["--get", "LocalHostName"], { timeout: 5000 })
      .toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

export function defaultAllowedHosts(lanIp: string, extra?: string[]): string[] {
  return buildAllowedHosts({
    lanIp,
    osHostname: hostname(),
    localHostName: localHostName(),
    extra,
  });
}
