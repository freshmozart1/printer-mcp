#!/usr/bin/env node
// End-to-end check against the real printer.
//
// Read-only by default. Physical actions are opt-in because they use paper and ink:
//   node scripts/smoke.mjs                 status, guards, tool list
//   node scripts/smoke.mjs --scan          also scan a page from the flatbed glass
//   node scripts/smoke.mjs --print         also print one test page
//   node scripts/smoke.mjs --duplex        also scan both sides from the feeder
//   node scripts/smoke.mjs --copy          also copy from the document feeder
//   node scripts/smoke.mjs --copy-duplex   also copy double-sided to double-sided
//   node scripts/smoke.mjs --stack         scan a 2-sheet duplex stack, check page order
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const flags = new Set(process.argv.slice(2));

// Scanning a feeder full of paper easily outruns the SDK's 60s default. Progress
// notifications from the server reset this timeout, so long scans survive.
const CALL_OPTIONS = {
  timeout: 120_000,
  maxTotalTimeout: 900_000,
  resetTimeoutOnProgress: true,
  onprogress: (p) => process.stdout.write(`\r  ...${p.message ?? "working"}   `),
};
const text = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const callTool = (params) => client.callTool(params, undefined, CALL_OPTIONS);
const image = (r) => r.content.find((c) => c.type === "image");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const client = new Client({ name: "printer-mcp-smoke", version: "1.0" });
await client.connect(new StdioClientTransport({
  command: "node", args: ["src/index.ts"], cwd: process.cwd(),
}));

console.log("\n== tools ==");
const { tools } = await client.listTools();
console.log(tools.map((t) => `  ${t.name}`).join("\n"));
check("all six tools are exposed", tools.length === 6, `${tools.length} found`);

console.log("\n== get_device_status ==");
const status = await callTool({ name: "get_device_status", arguments: {} });
console.log(text(status).split("\n").map((l) => `  ${l}`).join("\n"));
check("printer reachable", !text(status).includes("Printer: unreachable"));
check("scanner reachable", !text(status).includes("Scanner: unreachable"));
check("reports ink levels", /cartridge/.test(text(status)));

console.log("\n== security guards ==");
// /etc/hosts always exists, so this proves the allowlist rejected it rather than
// the path simply being missing.
const outside = await callTool({
  name: "print_file", arguments: { path: "/etc/hosts" },
});
check("refuses to print an existing file outside the allowlist",
  outside.isError === true && /outside the allowed/i.test(text(outside)),
  text(outside).slice(0, 90));

const badRange = await callTool({
  name: "print_file", arguments: { path: "~/Documents", page_ranges: "1;evil" },
});
check("refuses a malformed page range", badRange.isError === true);

const badJob = await callTool({
  name: "cancel_print_job", arguments: { job_id: "--all" },
});
check("refuses a job id that could be read as an option", badJob.isError === true);

console.log("\n== empty feeder handling ==");
// Only exercise this when the feeder really is empty. Calling scan_document with a
// loaded feeder would pull the whole stack through and scan it, which is emphatically
// not what someone running a read-only smoke test expects.
if (/Document feeder: empty/.test(text(status))) {
  const feeder = await callTool({ name: "scan_document", arguments: {} });
  check("empty feeder refuses instead of returning blank pages",
    feeder.isError === true && /feeder is empty/i.test(text(feeder)));
} else {
  console.log("  SKIP  feeder has paper loaded; skipping so the stack is not consumed");
}

if (flags.has("--scan")) {
  console.log("\n== scan from the flatbed glass ==");
  const scan = await callTool({
    name: "scan_document",
    arguments: { source: "flatbed", resolution: 200, color: "grayscale", ocr: true },
  });
  console.log(text(scan).split("\n").slice(0, 8).map((l) => `  ${l}`).join("\n"));
  check("scan succeeded", !scan.isError);
  check("saved a file and a download link", /Saved: .+\nDownload: http/.test(text(scan)));
  check("returned an inline preview image", Boolean(image(scan)));
  check("returned OCR text", /OCR text/.test(text(scan)));
}

if (flags.has("--duplex")) {
  console.log("\n== duplex scan from the document feeder ==");
  console.time("  scan duration");
  const scan = await callTool({
    name: "scan_document",
    arguments: {
      source: "adf-duplex", resolution: 300, color: "color", ocr: true,
      filename: "duplex-test",
    },
  });
  console.timeEnd("  scan duration");
  const body = text(scan);
  console.log(body.split("\n").map((l) => `  ${l}`).join("\n"));
  const img = image(scan);
  if (img) console.log(`  [preview] ${img.mimeType}, ~${Math.round(img.data.length / 4)} tokens`);
  check("duplex scan succeeded", !scan.isError);
  check("OCR returned text from the real page", /--- page 1 ---\n\s*\S/.test(body));
}

if (flags.has("--stack")) {
  // Expects the two duplex sheets produced by --print-file in the feeder.
  console.log("\n== multi-sheet duplex scan (page ordering) ==");
  console.time("  scan duration");
  const scan = await callTool({
    name: "scan_document",
    arguments: { source: "adf-duplex", resolution: 200, color: "grayscale",
                 filename: "stack-test" },
  });
  console.timeEnd("  scan duration");
  console.log(`  ${text(scan).split("\n")[0]}`);
  check("stack scan succeeded", !scan.isError);

  const file = /Saved: (\S+)/.exec(text(scan))?.[1];
  if (file) {
    const { ocrFile } = await import("../src/ocr/index.ts");
    const result = await ocrFile(file, { languages: ["en-US"], dpi: 200 });
    const pages = result?.pages ?? [];
    console.log(`  pages scanned: ${pages.length}`);
    pages.forEach((pg) => {
      const marker = /PAGE (ONE|TWO)/.exec(pg.text)?.[0] ?? "(no marker found)";
      console.log(`    page ${pg.page}: ${marker}`);
    });

    check("scanned 4 sides from 2 double-sided sheets", pages.length === 4,
      `${pages.length} page(s)`);
    // Correct interleaving is front,back,front,back — not all fronts then all backs.
    const order = pages.map((pg) => /PAGE (ONE|TWO)/.exec(pg.text)?.[1] ?? "?");
    check("pages are in front/back/front/back order",
      order.join(",") === "ONE,TWO,ONE,TWO", order.join(","));
  }
}

if (flags.has("--print-file")) {
  console.log("\n== print_file with duplex and multiple copies ==");
  const { renderToPdf } = await import("../src/render/textToPdf.ts");
  const { writeFile, unlink } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const nodePath = await import("node:path");

  // Two clearly distinct pages, so duplex output is obvious on the paper. The filler
  // forces a real page break — a one-page file would prove nothing about duplex.
  const filler = Array.from({ length: 46 }, (_, i) => `Filler line ${i + 1}.`).join("\n\n");
  const file = nodePath.join(homedir(), "Documents", "Scans", "print-file-test.pdf");
  const pdf = await renderToPdf(
    `# PAGE ONE (front)\n\nThis is the FRONT of the sheet.\n\n${filler}\n\n` +
    "# PAGE TWO (back)\n\nIf duplex worked, this is on the BACK of the same sheet.\n",
    { markdown: true });

  const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check("test document really has 2 pages", pageCount === 2, `${pageCount} page(s)`);
  if (pageCount !== 2) {
    console.log("  ABORT  refusing to print: a 1-page file cannot demonstrate duplex");
  } else {
  await writeFile(file, pdf);

  const printed = await callTool({
    name: "print_file",
    arguments: { path: file, sides: "two-sided-long-edge", copies: 2, quality: "draft" },
  });
  console.log(`  ${text(printed)}`);
  check("print_file accepted a duplex, multi-copy job", !printed.isError);
  check("reported a print job id", /Job id: \S+/.test(text(printed)));
  await unlink(file).catch(() => {});
  }
}

if (flags.has("--print")) {
  console.log("\n== print a test page ==");
  const printed = await callTool({
    name: "print_text",
    arguments: {
      title: "printer-mcp test page",
      content: "# It works\n\nPrinted by **printer-mcp**.\n\n- duplex supported\n- A4 loaded\n",
      quality: "draft",
    },
  });
  console.log(`  ${text(printed)}`);
  check("print job accepted", !printed.isError);
}

if (flags.has("--copy") || flags.has("--copy-duplex")) {
  const duplex = flags.has("--copy-duplex");
  console.log(`\n== copy from the document feeder${duplex ? " (duplex to duplex)" : ""} ==`);

  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const leftovers = async () =>
    (await readdir(tmpdir())).filter((n) => n.startsWith("printer-mcp-copy-"));
  const before = await leftovers();

  console.time("  copy duration");
  const copied = await callTool({
    name: "copy_document",
    arguments: duplex
      ? { source: "adf-duplex", sides: "two-sided-long-edge" }
      : {},
  });
  console.timeEnd("  copy duration");
  console.log(`  ${text(copied)}`);
  check("copy job accepted", !copied.isError);
  check("reported a print job id", /Job id: \S+/.test(text(copied)));

  const after = await leftovers();
  check("temp copy files cleaned up",
    after.length <= before.length, `${after.length} left behind`);
}

await client.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
