import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Sides = "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";
export type ColorMode = "color" | "monochrome" | "auto";
export type Quality = "draft" | "normal" | "high";

export interface PrintOptions {
  copies?: number;
  sides?: Sides;
  colorMode?: ColorMode;
  quality?: Quality;
  /** e.g. "1-4,7" */
  pageRanges?: string;
  /** e.g. "iso_a4_210x297mm" */
  media?: string;
  fitToPage?: boolean;
  title?: string;
}

export interface PrintJob {
  id: string;
  user: string;
  sizeBytes: number;
  submittedAt: string;
}

/** IPP print-quality enum (RFC 8011 §5.2.13). */
const QUALITY: Record<Quality, string> = { draft: "3", normal: "4", high: "5" };

const PAGE_RANGE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;

/**
 * Build the argument list for `lp`.
 *
 * Kept pure and separate from execution so the option mapping can be tested without
 * printing anything. Arguments are passed to `execFile` as an array, so there is no
 * shell involved and no quoting to get wrong.
 */
export function buildLpArgs(destination: string, file: string, opts: PrintOptions): string[] {
  const args = ["-d", destination];

  if (opts.copies !== undefined) {
    if (!Number.isInteger(opts.copies) || opts.copies < 1 || opts.copies > 99) {
      throw new Error(`Invalid copies: ${opts.copies}. The printer supports 1-99.`);
    }
    args.push("-n", String(opts.copies));
  }

  if (opts.title !== undefined) args.push("-t", opts.title);
  if (opts.sides) args.push("-o", `sides=${opts.sides}`);
  if (opts.colorMode) args.push("-o", `print-color-mode=${opts.colorMode}`);
  if (opts.quality) args.push("-o", `print-quality=${QUALITY[opts.quality]}`);
  if (opts.media) args.push("-o", `media=${opts.media}`);
  if (opts.fitToPage) args.push("-o", "fit-to-page");

  if (opts.pageRanges !== undefined) {
    if (!PAGE_RANGE.test(opts.pageRanges)) {
      throw new Error(`Invalid page range: "${opts.pageRanges}". Use a form like "1-4,7".`);
    }
    args.push("-o", `page-ranges=${opts.pageRanges}`);
  }

  // `--` guards against a filename that begins with a dash being read as an option.
  args.push("--", file);
  return args;
}

/** Pull the job id out of `lp`'s "request id is <dest>-<n> (1 file(s))" line. */
export function parseJobId(stdout: string): string | undefined {
  return /request id is (\S+)/.exec(stdout)?.[1];
}

/** Parse `lpstat -o` output: "<job-id> <user> <size> <date...>". */
export function parseJobs(stdout: string): PrintJob[] {
  const jobs: PrintJob[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    jobs.push({
      id: m[1]!,
      user: m[2]!,
      sizeBytes: Number(m[3]),
      submittedAt: m[4]!,
    });
  }
  return jobs;
}

export async function printFile(
  destination: string,
  file: string,
  opts: PrintOptions,
): Promise<{ jobId: string | undefined }> {
  const { stdout } = await run("lp", buildLpArgs(destination, file, opts), { timeout: 60_000 });
  return { jobId: parseJobId(stdout) };
}

/** List jobs still in the queue (not yet completed). */
export async function listJobs(destination?: string): Promise<PrintJob[]> {
  const args = ["-W", "not-completed", "-o"];
  if (destination) args.push(destination);
  try {
    const { stdout } = await run("lpstat", args, { timeout: 15_000 });
    return parseJobs(stdout);
  } catch {
    return []; // lpstat exits non-zero when the queue is empty on some systems.
  }
}

/** CUPS job ids look like "<destination>-<number>". */
const JOB_ID = /^[A-Za-z0-9_.\-]+-\d+$/;

export function assertValidJobId(jobId: string): string {
  // `cancel` does not accept a `--` separator, so the id is validated instead to keep
  // a value beginning with a dash from being read as an option.
  if (!JOB_ID.test(jobId)) {
    throw new Error(`Invalid job id: "${jobId}". Expected a form like "My_Printer-123".`);
  }
  return jobId;
}

export async function cancelJob(jobId: string): Promise<void> {
  await run("cancel", [assertValidJobId(jobId)], { timeout: 15_000 });
}

/** Names of the configured CUPS destinations, with the default flagged. */
export async function listDestinations(): Promise<{ name: string; isDefault: boolean }[]> {
  const [{ stdout: printers }, defaultName] = await Promise.all([
    run("lpstat", ["-p"], { timeout: 15_000 }).catch(() => ({ stdout: "" })),
    run("lpstat", ["-d"], { timeout: 15_000 })
      .then(({ stdout }) => /:\s*(\S+)/.exec(stdout)?.[1])
      .catch(() => undefined),
  ]);

  const names = [...printers.matchAll(/^printer (\S+)/gm)].map((m) => m[1]!);
  return names.map((name) => ({ name, isDefault: name === defaultName }));
}
