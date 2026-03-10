#!/usr/bin/env bash
set -euo pipefail

APP_HOME="${APP_HOME:-$HOME/app}"
SHARED_HOME="${SHARED_HOME:-$HOME/shared}"
SERVICE_NAME="${SERVICE_NAME:-fpom-backend.service}"
ALIASES_FILE="${ALIASES_FILE:-$HOME/.fpom_aliases}"
BACKEND_HOME="${BACKEND_HOME:-$APP_HOME/backend}"

ensure_shell_sources_aliases() {
  local rc_file="$1"
  local source_line="[ -f \"$ALIASES_FILE\" ] && source \"$ALIASES_FILE\""

  touch "$rc_file"
  if ! grep -Fqx "$source_line" "$rc_file"; then
    printf '\n%s\n' "$source_line" >>"$rc_file"
  fi
}

install_prod_aliases() {
  cat >"$ALIASES_FILE" <<EOF
# Managed by $APP_HOME/ops/server-deploy.sh
alias plogs_started='cd "$BACKEND_HOME" && npm run logs -- --started-games'
alias pstats_d='cd "$BACKEND_HOME" && npm run stats -- --period day'
alias pstats_mo='cd "$BACKEND_HOME" && npm run stats -- --period month'
EOF

  ensure_shell_sources_aliases "$HOME/.bashrc"
}

if [[ ! -d "$APP_HOME/.git" ]]; then
  echo "App checkout not found: $APP_HOME" >&2
  exit 1
fi

if [[ ! -f "$SHARED_HOME/backend.env" ]]; then
  echo "Missing shared env file: $SHARED_HOME/backend.env" >&2
  exit 1
fi

install_prod_aliases

cd "$BACKEND_HOME"
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
