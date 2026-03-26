#!/bin/bash
# Pre-build: copy match_invoices.py from checker source into build context.
# Run from the personal-assistant/ directory before docker compose build.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKER_SRC="$(cd "$SCRIPT_DIR/../../media-gpu/paperless/local/checker" && pwd)"

cp "$CHECKER_SRC/match_invoices.py" "$SCRIPT_DIR/match_invoices.py"
echo "Copied match_invoices.py from $CHECKER_SRC"
