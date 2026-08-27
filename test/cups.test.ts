import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildLpArgs, parseJobs, parseJobId, assertValidJobId } from "../src/printer/cups.ts";

const DEST = "HP_OfficeJet_Pro_9010_series__EXAMPLE_";

describe("buildLpArgs", () => {
  test("builds a minimal command with just the destination and file", () => {
    assert.deepEqual(buildLpArgs(DEST, "/tmp/a.pdf", {}), ["-d", DEST, "--", "/tmp/a.pdf"]);
  });

  test("passes copies through -n", () => {
    const args = buildLpArgs(DEST, "/tmp/a.pdf", { copies: 3 });
    assert.ok(args.includes("-n"));
    assert.equal(args[args.indexOf("-n") + 1], "3");
  });

  test("maps quality names onto IPP print-quality numbers", () => {
    const q = (quality: "draft" | "normal" | "high") =>
      buildLpArgs(DEST, "/tmp/a.pdf", { quality }).join(" ");
    assert.match(q("draft"), /print-quality=3/);
    assert.match(q("normal"), /print-quality=4/);
    assert.match(q("high"), /print-quality=5/);
  });

  test("sets duplex and colour options", () => {
    const args = buildLpArgs(DEST, "/tmp/a.pdf", {
      sides: "two-sided-long-edge", colorMode: "monochrome",
    }).join(" ");
    assert.match(args, /sides=two-sided-long-edge/);
    assert.match(args, /print-color-mode=monochrome/);
  });

  test("passes media, page ranges and the job title", () => {
    const args = buildLpArgs(DEST, "/tmp/a.pdf", {
      media: "iso_a4_210x297mm", pageRanges: "1-4,7", title: "Report",
    });
    assert.match(args.join(" "), /media=iso_a4_210x297mm/);
    assert.match(args.join(" "), /page-ranges=1-4,7/);
    assert.equal(args[args.indexOf("-t") + 1], "Report");
  });

  test("puts the filename last, after a -- separator", () => {
    // Without the separator a filename beginning with '-' would be read as an option.
    const args = buildLpArgs(DEST, "/tmp/-weird.pdf", { copies: 2 });
    assert.equal(args.at(-1), "/tmp/-weird.pdf");
    assert.equal(args.at(-2), "--");
  });

  test("rejects a copy count outside what the printer supports", () => {
    assert.throws(() => buildLpArgs(DEST, "/tmp/a.pdf", { copies: 0 }), /copies/i);
    assert.throws(() => buildLpArgs(DEST, "/tmp/a.pdf", { copies: 100 }), /copies/i);
    assert.throws(() => buildLpArgs(DEST, "/tmp/a.pdf", { copies: 1.5 }), /copies/i);
  });

  test("rejects a malformed page range rather than passing it to lp", () => {
    assert.throws(() => buildLpArgs(DEST, "/tmp/a.pdf", { pageRanges: "1;rm -rf" }), /page range/i);
    assert.throws(() => buildLpArgs(DEST, "/tmp/a.pdf", { pageRanges: "abc" }), /page range/i);
    assert.doesNotThrow(() => buildLpArgs(DEST, "/tmp/a.pdf", { pageRanges: "1-4,7,9-11" }));
  });
});

describe("parseJobId", () => {
  test("extracts the request id from lp output", () => {
    assert.equal(parseJobId(`request id is ${DEST}-254 (1 file(s))`), `${DEST}-254`);
  });
  test("returns undefined when lp prints something unexpected", () => {
    assert.equal(parseJobId("weird"), undefined);
  });
});

describe("parseJobs", () => {
  // Captured verbatim from `lpstat -o` on the real queue.
  const sample =
    `${DEST}-254 ole              15360   Thu Aug 27 23:14:17 2026\n` +
    `${DEST}-255 ole              4096    Thu Aug 27 23:15:02 2026\n`;

  test("parses each queued job", () => {
    const jobs = parseJobs(sample);
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs[0], {
      id: `${DEST}-254`, user: "ole", sizeBytes: 15360, submittedAt: "Thu Aug 27 23:14:17 2026",
    });
  });

  test("returns an empty list for an empty queue", () => {
    assert.deepEqual(parseJobs(""), []);
    assert.deepEqual(parseJobs("\n"), []);
  });

  test("ignores lines it cannot parse", () => {
    assert.deepEqual(parseJobs("no jobs here\n"), []);
  });
});

describe("assertValidJobId", () => {
  test("accepts a real CUPS job id", () => {
    assert.equal(assertValidJobId(`${DEST}-254`), `${DEST}-254`);
  });

  test("rejects ids that could be read as options or shell arguments", () => {
    // `cancel` takes no `--` separator, so the format check is the only guard.
    for (const bad of ["-a", "--all", `${DEST}`, "254", "foo-1 bar", "", "$(whoami)-1"]) {
      assert.throws(() => assertValidJobId(bad), /invalid job id/i, `should reject ${bad}`);
    }
  });
});
