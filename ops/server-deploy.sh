#!/usr/bin/env bash
set -euo pipefail

APP_HOME="${APP_HOME:-$HOME/app}"
SHARED_HOME="${SHARED_HOME:-$HOME/shared}"
SERVICE_NAME="${SERVICE_NAME:-fpom-backend.service}"

if [[ ! -d "$APP_HOME/.git" ]]; then
  echo "App checkout not found: $APP_HOME" >&2
  exit 1
fi

if [[ ! -f "$SHARED_HOME/backend.env" ]]; then
  echo "Missing shared env file: $SHARED_HOME/backend.env" >&2
  exit 1
fi

cd "$APP_HOME/backend"
ln -sfn "$SHARED_HOME/backend.env" .env
npm ci
npm run build
npm run prisma:sync
sudo -n /usr/bin/systemctl restart "$SERVICE_NAME"
sudo -n /usr/bin/systemctl is-active --quiet "$SERVICE_NAME"

for attempt in {1..15}; do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null; then
    exit 0
  fi
  sleep 1
done

echo "Backend health check failed after restart" >&2
exit 1
