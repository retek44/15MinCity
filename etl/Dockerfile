FROM python:3.13-slim-trixie

# osm2pgsql 2.x (flex output), osmium (extracts), psql + pg_prove (pgTAP runner)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        osm2pgsql \
        osmium-tool \
        postgresql-client \
        libtap-parser-sourcehandler-pgtap-perl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pmtiles CLI: cuts the Budapest basemap out of the Protomaps daily world build
ARG PMTILES_VERSION=1.31.2
ARG TARGETARCH
ADD https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz /tmp/pmtiles-amd64.tgz
ADD https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz /tmp/pmtiles-arm64.tgz
RUN tar -xzf /tmp/pmtiles-${TARGETARCH:-amd64}.tgz -C /usr/local/bin pmtiles \
    && rm /tmp/pmtiles-*.tgz \
    && pmtiles version

WORKDIR /app
COPY pyproject.toml ./
COPY reach15_etl ./reach15_etl
RUN pip install --no-cache-dir .
COPY lua ./lua

ENV REACH15_LUA=/app/lua/reach15.lua
ENTRYPOINT ["reach15-etl"]
