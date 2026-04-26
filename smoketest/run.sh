#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx --yes tsx src/cli.ts smoketest
