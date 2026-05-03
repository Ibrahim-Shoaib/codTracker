# Pinned to a specific patch version because Railway's Metal builder
# repeatedly hangs on `load metadata for docker.io/library/node:20-alpine`
# when Docker Hub is slow — pinning a static tag avoids re-fetching the
# floating "20-alpine" manifest on every build and lets the layer cache
# do its job. Bump intentionally when there's a security fix.
FROM node:20.18.1-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
