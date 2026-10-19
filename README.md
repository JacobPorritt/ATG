# ATG · Against the Grain

The most direct way across London by bike. ATG ignores the normal flow of
traffic: when going the wrong way down a one-way street or cutting through a
footpath is the shortest line, it takes it and tells you to hop off and walk
that bit.

Three ride styles:

* **Direct**: as the crow cycles. Shortest distance; walk-throughs only cost a little extra.
* **Chill**: quiet streets, fewer junctions, avoids big roads; only walks when it really pays.
* **Scenic**: canals, towpaths, parks and green space, even if it's the long way round.

Every route also shows how much faster it is than the by-the-book cycle route.

## How it works

```
OpenStreetMap (London)  ->  atgroute.build  ->  data/graph.npz
                                                     |
phone web app (web/)  <-  /api/routes  <-  atgroute.app (A* router)
```

* `atgroute/tags.py` decides, for each street and direction, whether you can
  **ride** it, **walk** it (pushing the bike), or neither. One-ways, legal
  contraflow lanes (`oneway:bicycle=no`), footpaths, steps and private roads
  are all handled here.
* `atgroute/build.py` cuts London into a routing graph and scores each street
  for how much of it runs through parks or along water.
* `atgroute/router.py` runs A* with a different cost per style. The numbers
  that set the feel of each style are in the `PROFILES` table at the top.
* `web/` is a phone-first web app (Vite + TypeScript + MapLibre) you can add to
  your home screen. Walk-through bits are drawn as dashed yellow, and in ride
  mode it warns you before you need to hop off.

Map data © OpenStreetMap contributors. Search uses Photon (komoot). The dark
basemap is OpenFreeMap (Liberty style), free with no key; swap it with `VITE_MAP_STYLE` if needed.

## Run it locally

Needs Python 3.11+, Node 20+ and about 4 GB of free RAM for the London build.

```sh
pip install -r requirements-dev.txt
./scripts/get_london.sh                # downloads London and builds data/graph.npz

uvicorn atgroute.app:app --port 8000   # API on :8000

cd web && npm install && npm run dev   # app on :5173, talks to the API
```

To try it on your phone, open the dev server's network address (run
`npm run dev -- --host`). Location needs HTTPS on a real phone, so for riding
with it, deploy it (below).

## Test site (no server)

`npm run build:test-site` in `web/` builds a version that routes entirely in
the browser: it downloads the streets around your trip live from
OpenStreetMap (Overpass API) and runs the same three styles in JavaScript
(`web/src/browser-router.ts`). It's slower and limited to trips up to about
12 km, but it can be hosted anywhere static. It's published to the
`gh-pages` branch for GitHub Pages.

## Wander and pub crawl

Wander fills a time window with stops on the way to where you need to be:
"I've got 5 hours, I need to be at King's Cross by 6, on a bike, in the mood
for coffee, galleries and a park."

* Venues come live from OpenStreetMap (`web/src/places.ts`). Anything tagged
  with a brand is left out, so it's independents only.
* Each venue is checked against its opening hours for the time you'd arrive
  and leave. Places with no hours listed can still appear, flagged "check
  opening times".
* The planner (`web/src/wander.ts`) spreads stops along the line to your end
  point, keeps detours short, orders the day sensibly (coffee first, pubs
  last), then routes every leg for real and re-times the day.
* Swap or remove any stop, or shuffle the whole plan.
* Pub crawl mode is walking only: short hops between independent pubs around
  an area you pick.

It's rule-based for now. An AI curator can later re-rank the same candidate
list (needs a small server to hold the API key).

## Google Maps comparison

Every route has an "Open in Google Maps" button. To show Google's own cycling
time (and its route as a grey line) next to ATG's, the app needs a Google Maps
API key with the **Maps JavaScript API** and **Routes API** enabled. Tap
"Show Google's time" in the app and paste it (it's saved on that phone only),
or bake it in at build time with `VITE_GOOGLE_MAPS_KEY`. Restrict the key to
your site's address in Google Cloud so nobody else can use it.

## Deploy

The Dockerfile does everything: builds the app, downloads London, builds the
graph and serves app and API from one container on `$PORT`. It runs happily on
a 1 GB instance on Fly.io, Railway or Render. Rebuild to refresh the map data
(bump the `MAP_VERSION` build arg).

```sh
docker build -t atg .
docker run -p 8000:8000 atg
```

## Tests

```sh
pytest
```

The tests build a tiny made-up neighbourhood (a one-way street, a parallel
road, a towpath through a park by a canal) and check that Direct walks the
wrong way down the one-way, Chill goes round legally and Scenic takes the
towpath.

## Ideas next

* Saved places and routes
* Feed of time saved vs Google
* User-submitted shortcuts (cut-throughs that aren't on the map yet)
* Native iOS/Android wrapper once the routing feels right
