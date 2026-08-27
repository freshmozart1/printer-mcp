import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// native/ocr, built by `npm run build:ocr`, sits two levels up from src/ocr/.
const BINARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "native", "ocr");

export interface OcrPage {
  page: number;
  text: string;
}

export interface OcrResult {
  pages: OcrPage[];
  text: string;
}

export interface OcrOptions {
  languages?: string[];
  dpi?: number;
}

export function isOcrAvailable(): boolean {
  return existsSync(BINARY);
}

/**
 * Extract text from a scanned PDF or image using Apple's Vision framework.
 *
 * Returns `undefined` rather than throwing when OCR is unavailable or fails: a scan
 * that produced a good file must never be reported as a failure just because the text
 * layer could not be read.
 */
export async function ocrFile(
  file: string,
  options: OcrOptions = {},
): Promise<OcrResult | undefined> {
  if (!isOcrAvailable()) return undefined;

  const args = [file, "--dpi", String(options.dpi ?? 200)];
  if (options.languages?.length) args.push("--languages", options.languages.join(","));

  try {
    const { stdout } = await run(BINARY, args, {
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as OcrResult;
    return parsed.pages ? parsed : undefined;
  } catch {
    return undefined;
  }
}
