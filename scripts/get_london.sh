#!/bin/sh
# Download the latest Greater London map data from Geofabrik (~110 MB)
# and build ATG's routing graph from it.
set -e
cd "$(dirname "$0")/.."
mkdir -p data
curl -L -o data/greater-london-latest.osm.pbf \
  https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf
python -m atgroute.build data/greater-london-latest.osm.pbf data/graph.npz
