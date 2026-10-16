"""HTTP API + static web app.

    ATG_GRAPH=data/graph.npz uvicorn atgroute.app:app --port 8000
"""
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .router import Graph, NoRoute, OutOfArea

GRAPH_PATH = os.environ.get("ATG_GRAPH", "data/graph.npz")
WEB_DIR = Path(os.environ.get("ATG_WEB", Path(__file__).resolve().parent.parent / "web" / "dist"))

@asynccontextmanager
async def lifespan(_app):
    if os.environ.get("ATG_LAZY") != "1":
        graph()   # load the graph before taking traffic
    yield


app = FastAPI(title="Against the Grain", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"])

_graph = None


def graph():
    global _graph
    if _graph is None:
        _graph = Graph(GRAPH_PATH)
    return _graph


def _point(s):
    try:
        lat, lon = (float(x) for x in s.split(","))
    except ValueError:
        raise HTTPException(400, "points look like 51.5074,-0.1278")
    return lat, lon


@app.get("/api/health")
def health():
    g = graph()
    return {"ok": True, "nodes": len(g.node_lon), "edges": len(g.edge_u)}


@app.get("/api/routes")
def routes(from_: str = Query(..., alias="from"), to: str = Query(...)):
    a = _point(from_)
    b = _point(to)
    try:
        return graph().routes(a[0], a[1], b[0], b[1])
    except OutOfArea:
        raise HTTPException(422, "That's outside the area ATG covers right now (London).")
    except NoRoute:
        raise HTTPException(404, "Couldn't find a way through. Try a point on a street.")


if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
