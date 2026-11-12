# Squadz · Caddy with ACME DNS-01 provider plugin
# Pin base images (no :latest)
FROM caddy:2.9.1-builder-alpine AS builder

# DNS_PROVIDER can be swapped at build time for any module under github.com/caddy-dns/*
ARG DNS_PROVIDER=github.com/caddy-dns/cloudflare

RUN xcaddy build \
    --with ${DNS_PROVIDER}

FROM caddy:2.9.1-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
