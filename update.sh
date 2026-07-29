#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
git pull --ff-only
open -a "Google Chrome" "chrome://extensions"

echo "ChatGPT Optimizer updated. Press Reload on its extension card, then refresh ChatGPT."
