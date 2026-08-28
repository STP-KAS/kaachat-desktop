# KaChat Desktop in a container.
#
# This runs Vite's dev server rather than building static files and serving them
# from nginx, which would be the obvious choice for a "production" image. It is
# deliberate: the Nextcloud integration is a `configureServer` middleware in
# vite.config.mjs (the /nc-proxy route that works around Nextcloud sending no
# CORS headers on WebDAV/OCS). Connect middleware only runs in the dev server, so
# a static build starts up looking completely normal and then fails every
# Nextcloud preview and every history backup, with nothing obvious to point at.
#
# If this ever moves to a static build, /nc-proxy has to be reimplemented in
# whatever ends up serving the files.

FROM node:22-alpine

# `npm run dev` shells out to tools/check-wasm.sh, and busybox sh is not bash.
RUN apk add --no-cache bash

WORKDIR /app

# Dependencies first, so editing application code does not re-resolve the tree.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# kaspa/ and cipher/ are committed, so there is no Rust toolchain here and
# nothing to fetch. check-wasm.sh fails loudly at startup if that changes.

EXPOSE 5173

# --host binds past loopback. Without it Vite listens only inside the
# container's own network namespace and the published port answers nothing.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
