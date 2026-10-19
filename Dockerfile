# One container: builds the web app, downloads London, builds the graph, serves it all.

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY atgroute ./atgroute

FROM base AS graph
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
# Bump this to force a fresh map download on the next build
ARG MAP_VERSION=1
RUN mkdir -p data && curl -fsSL --retry 3 -o data/london.osm.pbf \
      https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf \
 && python -m atgroute.build data/london.osm.pbf data/graph.npz \
 && rm data/london.osm.pbf

FROM base
COPY --from=graph /app/data/graph.npz ./data/graph.npz
COPY --from=web /web/dist ./web/dist
ENV ATG_GRAPH=/app/data/graph.npz ATG_WEB=/app/web/dist PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn atgroute.app:app --host 0.0.0.0 --port ${PORT}"]
