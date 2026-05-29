# capcut-cli — zero runtime deps, so the final image is just Node + dist/.
# Build:  docker build -t capcut-cli .
# Run:    docker run --rm -v "$PWD:/work" capcut-cli info /work/draft_content.json
#         cat jobs.jsonl | docker run --rm -i -v "$PWD:/work" capcut-cli serve

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json biome.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# No `npm install` here: the package declares zero runtime dependencies.
COPY --from=build /app/dist ./dist
COPY templates ./templates
COPY package.json ./
# Drafts are mounted at runtime; /work is the conventional mount point.
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--help"]
