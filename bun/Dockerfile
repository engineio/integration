# syntax=docker/dockerfile:1
#
# Two stages: a build stage that bundles + minifies the app to a single JS file, and a slim
# runtime that carries only that bundle plus the one thing that can't be bundled — the native
# TigerBeetle client.
#
# We deliberately do NOT `bun build --compile` to a standalone binary: the TigerBeetle client
# is a native (.node) addon whose loader resolves the addon via a computed path, which
# `--compile` skips — the resulting binary crashes at startup. A plain `bun build` bundle run
# by `bun` resolves the external client from node_modules normally, so no patching is needed.

# --- build: bundle + minify to one JS file ---------------------------------------------
FROM oven/bun:1.3 AS build
WORKDIR /app

# Production deps only (ajv gets bundled in; the native tigerbeetle-node stays external).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

# --minify shrinks the bundle; the migrate.macro inlines the SQL migrations into it at build
# time; --external keeps the native client out of the bundle (a .node addon can't be inlined
# into JS — it's shipped as a real file and required at runtime).
RUN bun build ./src/main.ts --target bun --minify --external tigerbeetle-node --outfile /app/main.js

# --- runtime: bun + the bundle + the native client only --------------------------------
FROM oven/bun:1.3-slim
WORKDIR /app

ENV NODE_ENV=production

# The minified bundle, plus the only dependency it couldn't inline: the native TigerBeetle
# client (zero runtime deps of its own, so copying just the package is enough). No source
# tree, no dev deps, no other node_modules.
COPY --from=build /app/main.js ./main.js
COPY --from=build /app/node_modules/tigerbeetle-node ./node_modules/tigerbeetle-node

EXPOSE 3000

# Runtime note for BALANCE_BACKEND=tigerbeetle: the TigerBeetle client uses io_uring, which
# Docker's default seccomp profile blocks (the client panics with "io_uring is not available /
# PermissionDenied"). Run it with a seccomp profile that allows io_uring_setup/enter/register
# — e.g. `docker run --security-opt seccomp=unconfined …`, or a k8s seccompProfile that permits
# those syscalls. The default Postgres backend needs none of this.

# Run as the image's unprivileged `bun` user.
USER bun
CMD ["bun", "run", "main.js"]
