import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Strip anything that could escape the scan directory or confuse a shell. */
export function safeBaseName(name: string, fallbackExt: string): string {
  const cleaned = path
    .basename(name)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 100);
  if (!cleaned) return `scan-${timestamp()}${fallbackExt}`;
  return path.extname(cleaned) ? cleaned : `${cleaned}${fallbackExt}`;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

/**
 * Sign a filename so a download link can be handed to a person without exposing the
 * server's bearer token. The signature is derived from the token, so links keep
 * working across restarts without any stored state.
 */
export function signName(name: string, token: string): string {
  return createHmac("sha256", token).update(name).digest("hex").slice(0, 32);
}

export function verifyName(name: string, signature: string, token: string): boolean {
  const expected = Buffer.from(signName(name, token));
  const given = Buffer.from(signature ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The machine's LAN address, so returned URLs work from other devices. */
export function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "127.0.0.1";
}

export function downloadUrl(
  name: string,
  opts: { host: string; port: number; token: string },
): string {
  return `http://${opts.host}:${opts.port}/files/${encodeURIComponent(name)}` +
    `?sig=${signName(name, opts.token)}`;
}

export async function saveScan(dir: string, name: string, data: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await writeFile(target, data);
  return target;
}

/**
 * Render a small JPEG of the first page for inline display.
 *
 * Deliberately small: an inline image costs roughly 5-10k tokens of context, so the
 * preview trades resolution for a cost the caller can absorb on every scan.
 */
export async function makePreview(
  file: string,
  outFile: string,
  { maxPx = 700, quality = 60 } = {},
): Promise<Buffer | undefined> {
  try {
    await run("sips", [
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(quality),
      "-Z", String(maxPx),
      file, "--out", outFile,
    ], { timeout: 60_000 });
    const { readFile } = await import("node:fs/promises");
    return await readFile(outFile);
  } catch {
    return undefined; // A missing preview must never fail the scan.
  }
}
