# syntax=docker/dockerfile:1

# ---- deps: install the whole workspace once ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY tools/mock-target/package.json tools/mock-target/
RUN npm ci --no-audit --no-fund

# ---- backend: api, worker, migrate and mock target all run from this image ----
FROM deps AS backend
COPY . .
ENV NODE_ENV=production
CMD ["npm", "run", "start", "-w", "@uhc/api"]

# ---- web: Next.js production build ----
FROM deps AS web
COPY . .
# NEXT_PUBLIC_API_URL is empty on purpose: with no explicit public origin the browser
# derives the API address from whatever host served the page, so the UI works on
# localhost and from other machines without a rebuild. Set it only when the API has
# its own domain behind a proxy.
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_API_PORT=4000
ARG NEXT_PUBLIC_MOCK_URL=http://mock:4100
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_API_PORT=$NEXT_PUBLIC_API_PORT \
    NEXT_PUBLIC_MOCK_URL=$NEXT_PUBLIC_MOCK_URL \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN npm run build -w @uhc/web
CMD ["npm", "run", "start", "-w", "@uhc/web"]
