#!/usr/bin/env bash
set -euo pipefail

unset CLOUDFLARE_API_TOKEN

bun run build:portal
wrangler pages deploy apps/portal/dist --project-name plannotator-portal --commit-dirty=true
wrangler --cwd apps/paste-service deploy
