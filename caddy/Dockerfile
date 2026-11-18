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

# Squadz branding (Block E2): title, favicon, manifest, theme CSS, first-run dark default.
# Every edit is followed by a grep so a Cinny bump that moves a pattern fails the build loudly.
COPY brand/squadz.css brand/squadz-init.js brand/manifest.json /srv/cinny/
COPY brand/icon.svg brand/icon-16.png brand/icon-32.png brand/icon-180.png brand/icon-192.png brand/icon-512.png /srv/cinny/squadz/
RUN cd /srv/cinny \
 && sed -i \
    -e 's|<title>Cinny</title>|<title>Squadz</title>|' \
    -e 's|content="Cinny"|content="Squadz"|g' \
    -e 's|content="#000000"|content="#0E0F22"|' \
    -e 's|<link id="favicon" rel="shortcut icon" href="[^"]*" />|<link id="favicon" rel="icon" type="image/png" sizes="32x32" href="/squadz/icon-32.png" /><link rel="icon" type="image/svg+xml" href="/squadz/icon.svg" />|' \
    -e 's|href="/assets/apple-touch-icon-[^"]*"|href="/squadz/icon-180.png"|g' \
    -e 's|</head>|<script src="/squadz-init.js"></script><link rel="stylesheet" href="/squadz.css" /></head>|' \
    index.html \
 && grep -q '<title>Squadz</title>' index.html \
 && grep -q 'href="/squadz.css"' index.html \
 && grep -q 'src="/squadz-init.js"' index.html \
 && grep -q 'data-call-embed-container' /srv/cinny/squadz-init.js \
 && grep -q 'squadz-golive' /srv/cinny/squadz.css \
 && grep -q 'data-call-embed-container' /srv/cinny/assets/index-*.js \
 && grep -q 'href="/squadz/icon-32.png"' index.html \
 && grep -q 'content="#0E0F22"' index.html \
 && grep -q 'content="Squadz"' index.html \
 && ! grep -q 'content="Cinny"' index.html \
 && grep -q 'rel="icon" type="image/svg+xml" href="/squadz/icon.svg"' index.html \
 && ! grep -q 'id="favicon" rel="shortcut icon"' index.html \
 && grep -q 'href="/squadz/icon-180.png"' index.html \
 && test -s /srv/cinny/manifest.json \
 && ! grep -q '<title>Cinny' index.html

FROM caddy:2.9.1-alpine AS final
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY --from=cinny /srv/cinny /srv/cinny
COPY web-client-entrypoint.sh /usr/local/bin/squadz-entrypoint.sh
RUN chmod 0755 /usr/local/bin/squadz-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/squadz-entrypoint.sh"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
