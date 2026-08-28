#!/usr/bin/env bash
# Compile the native OCR helper.
#
#   ./scripts/build-ocr.sh              build, failing if it cannot
#   ./scripts/build-ocr.sh --optional   warn and carry on instead of failing
#
# OCR is an optional feature: ocrFile() checks whether this binary exists and
# returns no text when it does not, so a scan still succeeds and still saves its
# file. Installation should therefore not be blocked by a missing compiler — but an
# explicit build request should still fail loudly.
set -euo pipefail

OPTIONAL=false
[[ "${1:-}" == "--optional" ]] && OPTIONAL=true

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SWIFTC="${SWIFTC:-swiftc}"

give_up() {
  if [[ "$OPTIONAL" == true ]]; then
    echo "printer-mcp: $1" >&2
    echo "printer-mcp: continuing without OCR — scanning still works, but" >&2
    echo "             scan_document's 'ocr' option will return no text." >&2
    echo "             Install the Xcode command line tools and run 'npm run build:ocr'." >&2
    exit 0
  fi
  echo "printer-mcp: $1" >&2
  exit 1
}

command -v "$SWIFTC" >/dev/null 2>&1 || give_up "no Swift compiler found ($SWIFTC)"

if ! "$SWIFTC" -O -parse-as-library native/ocr.swift -o native/ocr 2>/tmp/printer-mcp-ocr-build.log; then
  head -5 /tmp/printer-mcp-ocr-build.log >&2 || true
  give_up "the OCR helper failed to compile"
fi

echo "printer-mcp: built native/ocr"
