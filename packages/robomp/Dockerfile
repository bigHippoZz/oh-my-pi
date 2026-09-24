# syntax=docker/dockerfile:1.7-labs
###############################################################################
# robomp (TypeScript) — GitHub triage+fix bot orchestrator.
#
# Extends the default pi image (from /Dockerfile, target pi-runtime, tag
# oh-my-pi/pi:dev), which already carries the workspace source at /pi with a
# hydrated node_modules. This file layers a fresh copy of packages/robomp and
# the Vite-built dashboard bundle on top. The Python image (Dockerfile.robomp)
# is untouched; both read the same /data volume layout and SQLite schema.
#
# Build (from pi root):
#     bun run pi:image                                        # oh-my-pi/pi:dev
#     docker build -f packages/robomp/Dockerfile -t robomp-ts:dev .
#
# Compose (recommended):
#     docker compose --project-directory packages/robomp build
###############################################################################

ARG PI_BASE=oh-my-pi/pi:dev
ARG BUN_VERSION=1.4.2

############################
# 1) web-builder — Bun + Vite, builds the SolidJS dashboard bundle.
############################
FROM oven/bun:${BUN_VERSION}-slim AS web-builder
WORKDIR /work
COPY package.json bun.lock ./
COPY packages/robomp/web/package.json ./packages/robomp/web/package.json
# Root package.json declares patchedDependencies; the patch files must exist
# before any root-level `bun install` (even a filtered one).
COPY patches/*.patch ./patches/
RUN bun install --filter robomp-ts-web
COPY --exclude=node_modules --exclude=dist packages/robomp/web/ ./packages/robomp/web/
# The vite config fans the bundle out into ../src/static.
RUN mkdir -p packages/robomp/src && bun --cwd=packages/robomp/web run build

############################
# 2) runtime — pi image + robomp source + web bundle
############################
FROM ${PI_BASE} AS runtime

# robomp drives omp against the host pi checkout mounted at /work/pi
# read-only (the /usr/local/bin/omp shim resolves $PI_ROOT); robomp itself
# runs from the image's own workspace at /pi.
ENV PI_ROOT=/work/pi

COPY LICENSE THIRD-PARTY-NOTICES.txt /usr/share/doc/robomp/

# Fresh robomp sources over the base image's workspace copy (node_modules is
# hoisted at /pi/node_modules, so no install is needed).
COPY --exclude=node_modules --exclude=web packages/robomp/ /pi/packages/robomp/
COPY --from=web-builder /work/packages/robomp/src/static/ /pi/packages/robomp/src/static/

RUN printf '#!/bin/sh\nexec bun /pi/packages/robomp/src/cli.ts "$@"\n' > /usr/local/bin/robomp \
    && chmod +x /usr/local/bin/robomp

# Host agent config is mounted read-only under /srv/agent-home-stage; the
# entrypoint copies it into root-owned world-readable files under
# /srv/agent-home, which the agent subprocess uses as HOME.
RUN mkdir -p /srv/agent-home/.agent /srv/agent-home/.omp/agent \
    && mkdir -p /srv/agent-home-stage/.agent /srv/agent-home-stage/.omp/agent \
    && printf '[install]\nbackend = "copyfile"\n' > /srv/agent-home/.bunfig.toml

COPY packages/robomp/entrypoint.sh /usr/local/bin/robomp-entrypoint
RUN chmod +x /usr/local/bin/robomp-entrypoint

WORKDIR /app
VOLUME ["/data"]
EXPOSE 8080
EXPOSE 8081

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/robomp-entrypoint"]
CMD ["robomp", "serve"]
