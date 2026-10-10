# OSRM 仙台版（車）。OpenStreetMap の東北地方データから仙台市とその周辺だけを切り出して経路データを作る（ADR-0005）。
# 地図データは © OpenStreetMap contributors（ODbL）。

# 1) 東北地方のデータを取り、仙台市周辺（名取・多賀城・塩竈・富谷を含む）だけを切り出す
FROM debian:bookworm-slim AS extract
ARG PBF_URL=https://download.geofabrik.de/asia/japan/tohoku-latest.osm.pbf
# 西,南,東,北（経度・緯度）
ARG BBOX=140.20,38.00,141.10,38.50
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl osmium-tool \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /data
RUN curl -fsSL -o tohoku.osm.pbf "$PBF_URL"
# 地図データの日付（再現のため残す。取れなくても続ける）
RUN osmium fileinfo -g header.option.osmosis_replication_timestamp tohoku.osm.pbf > data_date.txt || echo unknown > data_date.txt
RUN osmium extract -b "$BBOX" --strategy complete_ways -o sendai.osm.pbf tohoku.osm.pbf && rm tohoku.osm.pbf

# 2) 経路データを作る（MLD）
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS build
WORKDIR /data
COPY --from=extract /data/sendai.osm.pbf /data/data_date.txt ./
RUN osrm-extract -p /opt/car.lua sendai.osm.pbf \
  && osrm-partition sendai.osrm \
  && osrm-customize sendai.osrm \
  && rm sendai.osm.pbf

# 3) 配信（Cloud Run は PORT=8080）
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1
WORKDIR /data
COPY --from=build /data /data
EXPOSE 8080
CMD ["osrm-routed", "--algorithm", "mld", "--port", "8080", "--max-table-size", "1000", "/data/sendai.osrm"]
