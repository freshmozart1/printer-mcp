# printer-mcp

An MCP server that gives AI assistants control of an **HP OfficeJet Pro 9015e** —
printing, scanning, copying and status — over the local network.

Runs on macOS. Talks to the printer two ways: printing goes through CUPS (which
converts PDFs, images and text into something the printer accepts), while scanning
speaks eSCL directly to the device.

## Tools

| Tool | What it does |
|---|---|
| `get_device_status` | Printer state, ink levels, loaded paper, print queue, scanner state, and whether the document feeder has paper. |
| `print_file` | Print an existing file (PDF, image, text). Restricted to allowed folders. |
| `print_text` | Typeset text or markdown and print it — headings, bold, lists, code blocks. |
| `cancel_print_job` | Cancel a queued job by id. |
| `scan_document` | Scan to PDF or JPEG. **Defaults to the document feeder.** Optional OCR and inline preview. |
| `copy_document` | Scan and print straight back out. **Defaults to the document feeder.** Supports duplex-to-duplex. |

### Scanning defaults

`scan_document` and `copy_document` both default to `source: "adf"` — the document
feeder on top of the printer. Other sources:

- `adf-duplex` — both sides of each sheet
- `flatbed` — a single page on the glass

If the feeder is empty, both tools **fail with a clear message** rather than falling
back to the glass. Silently falling back would return blank pages, and for
`copy_document` would print them.

### OCR is best-effort

`scan_document` with `ocr: true` runs Apple's Vision text recogniser on-device. It is
good on ordinary printed documents but makes mistakes on small or unusual type. The
saved file is always the authoritative result — do not treat OCR output as an exact
transcription of anything critical.

## Setup

```bash
npm install          # also compiles the native OCR helper
npm test
```

Requires Node 24+ (TypeScript runs natively, no build step) and Xcode command line
tools for the OCR helper.

### Running

```bash
npm start            # stdio — for a client on this Mac
npm run start:http   # HTTP on 0.0.0.0:8765 — reachable from the LAN
```

To run permanently in the background, starting at login and restarting on crash:

```bash
./scripts/install-agent.sh
```

Logs go to `~/Library/Logs/printer-mcp.log`. Remove it with
`./scripts/install-agent.sh --uninstall`.

> The agent records the absolute path of `node`. Because this machine uses nvm, that
> path changes when you upgrade Node — **re-run the install script after a Node
> upgrade.**

### Connecting a client

Over stdio, point the client at `node /path/to/printer-mcp/src/index.ts`.

Over the network, the endpoint is `http://<this-mac>:8765/mcp` and every request needs
the bearer token printed at startup (also in `~/.config/printer-mcp/token`):

```bash
curl -H "Authorization: Bearer $(cat ~/.config/printer-mcp/token)" http://192.168.1.10:8765/mcp
```

## Security

The server drives hardware and reads files, and it listens on the LAN, so:

- **Bearer token** required on every MCP request; generated on first run.
- **DNS-rebinding protection** — requests with a foreign `Host` header are rejected.
- **Path allowlist** — `print_file` only reads from `~/Documents`, `~/Downloads`,
  `~/Desktop` and the scan folder. Paths are resolved through `realpath` first, so
  `..` and symlinks cannot escape.
- **Signed download links** — saved scans are served at `/files/<name>?sig=…`, where
  the signature is derived from the token. A link can be shared with a person without
  handing over the token.
- `/health` is intentionally unauthenticated and returns only `{"ok":true}`.

## Configuration

All optional; sensible defaults are used.

| Variable | Default |
|---|---|
| `PRINTER_MCP_PRINTER_HOST` | `HPEXAMPLE12345.local` |
| `PRINTER_MCP_CUPS_DEST` | `HP_OfficeJet_Pro_9010_series__EXAMPLE_` |
| `PRINTER_MCP_SCAN_DIR` | `~/Documents/Scans` |
| `PRINTER_MCP_ALLOWED_DIRS` | Documents, Downloads, Desktop, scan dir |
| `PRINTER_MCP_PORT` | `8765` |
| `PRINTER_MCP_BIND` | `0.0.0.0` |
| `PRINTER_MCP_TOKEN` | generated and stored on first run |
| `PRINTER_MCP_OCR_LANGUAGES` | `de-DE,en-US` |
| `PRINTER_MCP_OCR_DPI` | `200` |

## Verifying against the real printer

`npm test` covers the logic without touching hardware. To exercise the device:

```bash
node scripts/smoke.mjs           # status, security guards, empty-feeder handling
node scripts/smoke.mjs --scan    # also scans a page from the glass
node scripts/smoke.mjs --print   # also prints one test page
node scripts/smoke.mjs --copy    # also copies from the document feeder (needs paper)
```
