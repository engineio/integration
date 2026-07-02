# syntax=docker/dockerfile:1
#
# Development image with hot reloading. Bind-mount the source over /app and Bun's
# `--hot` reloads changed modules in place — Bun.serve keeps the listening socket
# open across reloads, so the server updates without a restart or dropped connections.
#
#   docker build -f local.Dockerfile -t wallet-dev .
#   docker run --rm -it -p 3000:3000 \
#     -e DATABASE_URL='postgres://postgres:postgres@host.docker.internal:5432/operator' \
#     -e RGS_PUBLIC_KEY="$(base64 < public.key)" \
#     -e DEV_ENDPOINTS=true \
#     -v "$PWD":/app -v /app/node_modules \
#     wallet-dev
#
# The `-v /app/node_modules` anonymous volume keeps the image's (Linux) node_modules
# from being shadowed by a host bind mount (e.g. macOS-built modules).

FROM oven/bun:1.3
WORKDIR /app

# Install deps at build time so the image runs even without a host node_modules.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Baked in for standalone runs; overlaid by the bind mount during development.
COPY . .

ENV NODE_ENV=development
EXPOSE 3000

# --hot: reload changed modules in-process (Bun.serve reuses the running server).
# Swap for `--watch` if you'd rather fully restart the process on each change.
CMD ["bun", "--hot", "src/main.ts"]
