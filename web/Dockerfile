FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Type checking and tests run in CI; the image only needs the bundle, precompressed for Caddy.
RUN npx vite build && node scripts/precompress.mjs

FROM caddy:2-alpine
# Not root, so the site listens on 8080 instead of 80; /data and /config are Caddy's state.
RUN addgroup -S -g 10001 caddy     && adduser -S -u 10001 -G caddy -H caddy     && chown -R caddy:caddy /data /config
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv
USER 10001:10001
EXPOSE 8080
