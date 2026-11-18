#!/bin/sh
# Squadz · render Cinny's config.json from CHAT_FQDN at container start, then exec the real command.
# Template: config/web-client/config.json.template (mounted read-only by docker-compose.yml).
set -eu
: "${CHAT_FQDN:?CHAT_FQDN must be set}"
TEMPLATE="${SQUADZ_WEB_CLIENT_TEMPLATE:-/etc/squadz/web-client/config.json.template}"
OUT="${SQUADZ_WEB_CLIENT_ROOT:-/srv/cinny}/config.json"
sed "s/__CHAT_FQDN__/${CHAT_FQDN}/g" "$TEMPLATE" > "$OUT"
exec "$@"
