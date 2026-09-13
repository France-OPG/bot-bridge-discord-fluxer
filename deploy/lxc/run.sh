#!/usr/bin/env bash
# Lance le pont en avant-plan (conteneur sans systemd, tmux, debug, docker…).
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node dist/index.js