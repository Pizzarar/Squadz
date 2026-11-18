# Squadz · Caddy with ACME DNS-01 provider plugin
# Pin base images (no :latest)
FROM caddy:2.9.1-builder-alpine AS builder

# DNS_PROVIDER can be swapped at build time for any module under github.com/caddy-dns/*
ARG DNS_PROVIDER=github.com/caddy-dns/cloudflare

RUN xcaddy build \
    --with ${DNS_PROVIDER}

# Hosted web client (Block C3b): Cinny, pinned release tarball with sha256 verification.
# Source: https://github.com/cinnyapp/cinny/releases/tag/v4.12.8 (asset cinny-v4.12.8.tar.gz).
# The checksum was computed from that asset; bump version and checksum together.
FROM alpine:3.20 AS cinny
ARG CINNY_VERSION=4.12.8
ARG CINNY_SHA256=70784a4d52b83183b30e79d5cf40cf8c7ce973bf4181cacfa361d8633bb619b5
RUN wget -q -O /tmp/cinny.tar.gz \
      "https://github.com/cinnyapp/cinny/releases/download/v${CINNY_VERSION}/cinny-v${CINNY_VERSION}.tar.gz" \
 && echo "${CINNY_SHA256}  /tmp/cinny.tar.gz" | sha256sum -c - \
 && mkdir -p /srv/cinny \
 && tar -xzf /tmp/cinny.tar.gz -C /srv/cinny --strip-components=1 \
 && test -f /srv/cinny/index.html

FROM caddy:2.9.1-alpine AS final
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY --from=cinny /srv/cinny /srv/cinny
COPY web-client-entrypoint.sh /usr/local/bin/squadz-entrypoint.sh
RUN chmod 0755 /usr/local/bin/squadz-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/squadz-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
