import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { printFile } from "../printer/cups.ts";
import type { PrintOptions } from "../printer/cups.ts";
import { renderToPdf } from "../render/textToPdf.ts";
import { resolveAllowedPath } from "../config.ts";
import type { Config } from "../config.ts";

/** Print options shared by print_file and print_text. */
const printShape = {
  copies: z.number().int().min(1).max(99).optional()
    .describe("Number of copies (1-99). Defaults to 1."),
  sides: z.enum(["one-sided", "two-sided-long-edge", "two-sided-short-edge"]).optional()
    .describe(
      "Duplex mode. 'two-sided-long-edge' is normal double-sided printing for portrait " +
      "pages; 'two-sided-short-edge' flips on the short edge, for landscape.",
    ),
  color: z.enum(["color", "monochrome", "auto"]).optional()
    .describe("Colour mode. Use 'monochrome' to save colour ink."),
  quality: z.enum(["draft", "normal", "high"]).optional()
    .describe("Print quality. 'draft' is faster and uses less ink."),
  media: z.string().optional()
    .describe("Paper size, e.g. 'iso_a4_210x297mm'. Defaults to whatever is loaded."),
};

function toPrintOptions(args: Record<string, unknown>): PrintOptions {
  return {
    copies: args.copies as number | undefined,
    sides: args.sides as PrintOptions["sides"],
    colorMode: args.color as PrintOptions["colorMode"],
    quality: args.quality as PrintOptions["quality"],
    media: args.media as string | undefined,
  };
}

function describe(opts: PrintOptions, extra: string[] = []): string {
  const parts = [...extra];
  if (opts.copies && opts.copies > 1) parts.push(`${opts.copies} copies`);
  if (opts.sides && opts.sides !== "one-sided") parts.push("double-sided");
  if (opts.colorMode) parts.push(opts.colorMode);
  if (opts.quality) parts.push(`${opts.quality} quality`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export function registerPrintTools(server: McpServer, config: Config): void {
  server.registerTool(
    "print_file",
    {
      title: "Print a file",
      description:
        "Print an existing file on the HP OfficeJet Pro 9015e. Accepts PDFs, images " +
        "and plain text; the print system converts them automatically. The file must " +
        `live inside one of the allowed folders: ${config.allowedPrintDirs.join(", ")}. ` +
        "To print content you have written yourself, use print_text instead.",
      inputSchema: {
        path: z.string().describe("Absolute path of the file to print. '~' is expanded."),
        page_ranges: z.string().optional()
          .describe("Pages to print, e.g. '1-4,7'. Defaults to the whole document."),
        ...printShape,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const file = await resolveAllowedPath(args.path, config.allowedPrintDirs);
      const options: PrintOptions = {
        ...toPrintOptions(args),
        pageRanges: args.page_ranges,
        title: path.basename(file),
      };

      const { jobId } = await printFile(config.cupsDestination, file, options);
      return {
        content: [{
          type: "text",
          text: `Sent ${path.basename(file)} to the printer${describe(options)}.` +
            (jobId ? ` Job id: ${jobId}` : ""),
        }],
      };
    },
  );

  server.registerTool(
    "print_text",
    {
      title: "Print text or markdown",
      description:
        "Typeset text you provide and print it. Markdown is rendered with real " +
        "formatting (headings, bold, italic, bullet and numbered lists, block quotes, " +
        "code blocks) onto A4. Use this for notes, letters, checklists and reports you " +
        "have written; use print_file for a document that already exists on disk.",
      inputSchema: {
        content: z.string().describe("The text or markdown to print."),
        title: z.string().optional()
          .describe("Optional heading printed at the top and used as the job name."),
        markdown: z.boolean().optional()
          .describe("Parse the content as markdown. Defaults to true."),
        ...printShape,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const pdf = await renderToPdf(args.content, {
        markdown: args.markdown ?? true,
        title: args.title,
      });

      // The rendered document is transient; it exists only long enough to be spooled.
      const dir = await mkdtemp(path.join(tmpdir(), "printer-mcp-"));
      const file = path.join(dir, `${(args.title ?? "document").replace(/[^\w.-]+/g, "_")}.pdf`);
      try {
        await writeFile(file, pdf);
        const options: PrintOptions = {
          ...toPrintOptions(args),
          title: args.title ?? "Printed text",
        };
        const { jobId } = await printFile(config.cupsDestination, file, options);
        return {
          content: [{
            type: "text",
            text: `Printed ${args.title ? `"${args.title}"` : "the text"}` +
              `${describe(options)}.` + (jobId ? ` Job id: ${jobId}` : ""),
          }],
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
