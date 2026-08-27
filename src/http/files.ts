import express from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { verifyName } from "../files.ts";
import type { Config } from "../config.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/**
 * Serve saved scans over the LAN.
 *
 * Access is granted by a per-file signature rather than the server's bearer token, so
 * a link can be shared with a person without handing over the token itself.
 */
export function filesRouter(config: Config): express.Router {
  const router = express.Router();

  router.get("/files/:name", async (req, res) => {
    // `path.basename` keeps a crafted name from walking out of the scan directory.
    const name = path.basename(req.params.name);
    const signature = String(req.query.sig ?? "");

    if (!verifyName(name, signature, config.token)) {
      res.status(403).type("text/plain").send("Invalid or missing signature");
      return;
    }

    const file = path.join(config.scanDir, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
      res.setHeader("Content-Type", CONTENT_TYPES[path.extname(name).toLowerCase()] ??
        "application/octet-stream");
      res.setHeader("Content-Length", info.size);
      res.setHeader("Content-Disposition", `inline; filename="${name}"`);
      createReadStream(file).pipe(res);
    } catch {
      res.status(404).type("text/plain").send("Not found");
    }
  });

  return router;
}
