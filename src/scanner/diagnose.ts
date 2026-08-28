import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Reachability = "process-blocked" | "host-unreachable" | "unknown";

export interface Diagnosis {
  kind: Reachability;
  hint: string;
}

/**
 * Check whether the machine as a whole can reach the printer.
 *
 * Uses `curl`, a separate binary with its own network permissions, as a control. If
 * curl reaches the printer but our own socket did not, the restriction is on this
 * process rather than the network.
 */
async function probeWithCurl(host: string): Promise<boolean> {
  try {
    await run("curl", [
      "-sk", "--max-time", "5", "-o", "/dev/null",
      `https://${host}/eSCL/ScannerStatus`,
    ], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a connection failure into an explanation the reader can act on.
 *
 * macOS returns EHOSTUNREACH when an application is denied Local Network access, which
 * is indistinguishable from a genuinely absent device unless something else on the
 * machine is known to reach it.
 */
export async function diagnoseUnreachable(
  host: string,
  probe: (host: string) => Promise<boolean> = probeWithCurl,
): Promise<Diagnosis> {
  // A diagnosis must never be the thing that fails: this runs on an error path.
  const hostReachable = await probe(host).catch(() => false);

  if (hostReachable) {
    return {
      kind: "process-blocked",
      hint:
        `The printer at ${host} answers other programs on this Mac, so it is switched ` +
        "on and on the network — this process specifically is being stopped from " +
        "reaching it.\n" +
        "On macOS 15 and later an app must be granted Local Network access before it, " +
        "or anything it launches, can talk to devices on your network. Enable the app " +
        "running this server (Claude, Claude Code, or Terminal) under System Settings > " +
        "Privacy & Security > Local Network, then restart that app.\n" +
        "An outbound firewall such as LuLu or Little Snitch can block it the same way; " +
        "check for a rule covering the node binary.",
    };
  }

  return {
    kind: "host-unreachable",
    hint:
      `Nothing on this Mac can reach the printer at ${host}. Check that it is switched ` +
      "on and connected to the same network, and that its address is still correct — " +
      "a DHCP lease may have moved it. Set PRINTER_MCP_PRINTER_HOST in " +
      "~/.config/printer-mcp/env if the address has changed.",
  };
}
