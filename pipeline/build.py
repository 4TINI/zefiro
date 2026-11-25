#!/usr/bin/env python3
"""Zefiro – pipeline dati del prototipo.

Scarica una volta sola i dati della finestra configurata e scrive JSON statici:

  bulletins.json  bollettini AINEVA (CAAML v6) per le micro-regioni del Piemonte
  regions.geojson poligoni delle micro-regioni (semplificati)
  routes.json     gite: traccia di salita con quota, pendenza ed esposizione dal DEM,
                  meteo orario/giornaliero a partenza e vetta, relazioni Gulliver
  siva_<id>.geojson siti valanghivi storici Arpa Piemonte attorno alla gita
  meta.json       finestra temporale e fonti
"""
from __future__ import annotations

import datetime as dt
import base64
import json
import math
import os
import pathlib
import sys
import time
import xml.etree.ElementTree as ET

import numpy as np
import rasterio
import requests
import yaml
from rasterio.windows import from_bounds
from shapely.geometry import Point, shape, mapping

HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(os.environ.get("ZEFIRO_OUT", HERE.parent / "web" / "public" / "data"))
CACHE = pathlib.Path(os.environ.get("ZEFIRO_CACHE", HERE / "cache"))
UA = {"User-Agent": "zefiro-prototype/0.1"}

DANGER = {"low": 1, "moderate": 2, "considerable": 3, "high": 4, "very_high": 5}
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def log(msg: str) -> None:
    print(f"[zefiro] {msg}", flush=True)


def get(url: str, *, cache_name: str | None = None, params: dict | None = None,
        as_json: bool = True, retries: int = 3):
    """GET con cache su disco: rilanciare la pipeline non riscarica nulla."""
    path = CACHE / cache_name if cache_name else None
    if path and path.exists():
        data = path.read_bytes()
    else:
        for attempt in range(retries):
            try:
                r = requests.get(url, params=params, headers=UA, timeout=60)
                r.raise_for_status()
                data = r.content
                break
            except requests.RequestException as exc:
                if attempt == retries - 1:
                    raise
                log(f"  retry {url} ({exc})")
                time.sleep(2 * (attempt + 1))
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    return json.loads(data) if as_json else data


def daterange(start: dt.date, end: dt.date):
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


# --------------------------------------------------------------------------- AINEVA

def _elev(bound, treeline: int):
    if bound is None:
        return None
    if str(bound).lower() == "treeline":
        return treeline
    return int(bound)


def parse_bulletin(b: dict, treeline: int) -> dict:
    ratings = []
    for r in b.get("dangerRatings", []):
        el = r.get("elevation", {}) or {}
        ratings.append({
            "level": DANGER.get(r["mainValue"], 0),
            "lower": _elev(el.get("lowerBound"), treeline),
            "upper": _elev(el.get("upperBound"), treeline),
            "period": r.get("validTimePeriod", "all_day"),
        })
    problems = []
    for p in b.get("avalancheProblems", []):
        el = p.get("elevation", {}) or {}
        problems.append({
            "type": p["problemType"],
            "lower": _elev(el.get("lowerBound"), treeline),
            "upper": _elev(el.get("upperBound"), treeline),
            "aspects": [a for a in SECTORS if a in p.get("aspects", [])],
            "period": p.get("validTimePeriod", "all_day"),
            "stability": p.get("snowpackStability"),
            "frequency": p.get("frequency"),
            "size": p.get("avalancheSize"),
        })
    tendency = (b.get("tendency") or [{}])[0]
    return {
        "published": b.get("publicationTime"),
        "unscheduled": b.get("unscheduled", False),
        "ratings": ratings,
        "max_level": max((r["level"] for r in ratings), default=0),
        "problems": problems,
        "highlights": (b.get("avalancheActivity") or {}).get("highlights"),
        "activity": (b.get("avalancheActivity") or {}).get("comment"),
        "snowpack": (b.get("snowpackStructure") or {}).get("comment"),
        "tendency": tendency.get("tendencyType"),
        "tendency_text": tendency.get("highlights"),
    }


def build_bulletins(cfg: dict, first: dt.date, last: dt.date) -> dict:
    a = cfg["aineva"]
    out: dict[str, dict] = {}
    for day in daterange(first, last):
        ds = day.isoformat()
        url = a["bulletin_json"].format(date=ds)
        data = get(url, cache_name=f"aineva/{ds}.json")
        per_region: dict[str, dict] = {}
        for b in data.get("bulletins", []):
            ids = [r["regionID"] for r in b.get("regions", [])]
            mine = [i for i in ids if i.startswith(a["region_prefix"])]
            if not mine:
                continue
            parsed = parse_bulletin(b, a["treeline_m"])
            for rid in mine:
                prev = per_region.get(rid)
                # Se ci sono più bollettini (es. aggiornamento straordinario) vince il più recente.
                if prev is None or (parsed["published"] or "") > (prev["published"] or ""):
                    per_region[rid] = parsed
        out[ds] = per_region
        log(f"AINEVA {ds}: {len(per_region)} micro-regioni")
    return out


def build_regions(cfg: dict) -> tuple[dict, list]:
    data = get(cfg["aineva"]["micro_regions"], cache_name="aineva/micro-regions.geojson")
    names = get(cfg["aineva"]["micro_region_names"], cache_name="aineva/micro-region-names-it.json")
    feats, shapes = [], []
    for f in data["features"]:
        if f["properties"].get("end_date"):
            continue  # confini storici
        geom = shape(f["geometry"]).simplify(0.002, preserve_topology=True)
        feats.append({"type": "Feature", "properties": {"id": f["properties"]["id"],
                                                     "name": names.get(f["properties"]["id"])},
                      "geometry": mapping(geom)})
        shapes.append((f["properties"]["id"], shape(f["geometry"])))
    return {"type": "FeatureCollection", "features": feats}, shapes


# --------------------------------------------------------------------------- tracce + DEM

def haversine(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def resample(points: list[tuple[float, float]], step: float) -> list[tuple[float, float]]:
    """Ricampiona una polilinea a passo costante (in metri)."""
    out = [points[0]]
    carry = 0.0
    for (la1, lo1), (la2, lo2) in zip(points, points[1:]):
        seg = haversine(la1, lo1, la2, lo2)
        if seg == 0:
            continue
        pos = step - carry
        while pos <= seg:
            t = pos / seg
            out.append((la1 + t * (la2 - la1), lo1 + t * (lo2 - lo1)))
            pos += step
        carry = seg - (pos - step)
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out


def read_gpx(raw: bytes) -> list[tuple[float, float]]:
    root = ET.fromstring(raw)
    ns = {"g": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    q = ".//g:trkpt" if ns else ".//trkpt"
    return [(float(p.get("lat")), float(p.get("lon"))) for p in root.iterfind(q, ns)]


class Dem:
    """Finestra del DEM attorno a una traccia, con pendenza ed esposizione."""

    def __init__(self, url_tpl: str, lats, lons, margin=0.01):
        lat0, lon0 = math.floor(min(lats)), math.floor(min(lons))
        if math.floor(max(lats)) != lat0 or math.floor(max(lons)) != lon0:
            raise SystemExit("traccia a cavallo di due tile DEM: non gestito nel prototipo")
        url = url_tpl.format(lat=f"N{lat0:02d}", lon=f"E{lon0:03d}")
        self.bounds = (min(lons) - margin, min(lats) - margin, max(lons) + margin, max(lats) + margin)
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MAX_RETRY="3"):
            with rasterio.open("/vsicurl/" + url) as src:
                win = from_bounds(*self.bounds, transform=src.transform).round_offsets().round_lengths()
                self.z = src.read(1, window=win).astype("float64")
                self.tf = src.window_transform(win)
        lat_c = (self.bounds[1] + self.bounds[3]) / 2
        dx = self.tf.a * 111320.0 * math.cos(math.radians(lat_c))   # m per pixel (est)
        dy = -self.tf.e * 110540.0                                   # m per pixel (nord)
        gy, gx = np.gradient(self.z, dy, dx)       # le righe crescono verso sud
        dzdn, dzde = -gy, gx
        self.slope = np.degrees(np.arctan(np.hypot(dzde, dzdn)))
        # esposizione = direzione verso cui scende il pendio (0 = N, 90 = E)
        self.aspect = (np.degrees(np.arctan2(-dzde, -dzdn)) + 360.0) % 360.0
        # pendenza massima nell'intorno (~±1 pixel): coglie il pendio sopra/sotto la traccia
        pad = np.pad(self.slope, 1, mode="edge")
        stack = [pad[1 + i:pad.shape[0] - 1 + i, 1 + j:pad.shape[1] - 1 + j]
                 for i in (-1, 0, 1) for j in (-1, 0, 1)]
        self.slope_max = np.max(stack, axis=0)
        log(f"  DEM {url.rsplit('/', 1)[-1]} finestra {self.z.shape}, pixel {dx:.0f}x{dy:.0f} m")

    def export_grid(self) -> dict:
        """Griglia compatta per la vista 3D: quota (int16), pendenza (uint8), settore di esposizione (uint8).

        Righe da nord a sud, colonne da ovest a est; array in base64 little-endian.
        """
        rows, cols = self.z.shape
        west, north = self.tf.c, self.tf.f
        east, south = west + self.tf.a * cols, north + self.tf.e * rows
        b64 = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()
        sector = (((self.aspect + 22.5) % 360) // 45).astype("uint8")
        return {
            "w": cols, "h": rows, "bounds": [round(west, 6), round(south, 6), round(east, 6), round(north, 6)],
            "ele": b64(np.round(self.z).astype("<i2")),
            "slope": b64(np.clip(np.round(self.slope), 0, 90).astype("uint8")),
            "aspect": b64(sector),
        }

    def to_rc(self, lat: float, lon: float) -> tuple[int, int]:
        col, row = ~self.tf * (lon, lat)
        return int(round(row)), int(round(col))

    def to_latlon(self, r: int, c: int) -> tuple[float, float]:
        lon, lat = self.tf * (c + 0.5, r + 0.5)
        return lat, lon

    def least_cost_path(self, a: tuple[float, float], b: tuple[float, float]) -> list[tuple[float, float]]:
        """Percorso a costo minimo tra due punti (Dijkstra, 8 vicini).

        Il costo cresce molto sopra i 25°: imita una traccia di salita con
        inversioni, che evita pareti e pendii estremi.
        """
        import heapq
        rows, cols = self.z.shape
        lat_c = (self.bounds[1] + self.bounds[3]) / 2
        px_e = self.tf.a * 111320.0 * math.cos(math.radians(lat_c))
        px_n = -self.tf.e * 110540.0
        penalty = 1.0 + (np.clip(self.slope - 25.0, 0, None) / 5.0) ** 2
        start, goal = self.to_rc(*a), self.to_rc(*b)
        dist = np.full(self.z.shape, np.inf)
        prev = {}
        dist[start] = 0.0
        heap = [(0.0, start)]
        steps = [(dr, dc, math.hypot(dr * px_n, dc * px_e))
                 for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc]
        while heap:
            d, (r, c) = heapq.heappop(heap)
            if (r, c) == goal:
                break
            if d > dist[r, c]:
                continue
            for dr, dc, length in steps:
                nr, nc = r + dr, c + dc
                if not (0 <= nr < rows and 0 <= nc < cols):
                    continue
                nd = d + length * 0.5 * (penalty[r, c] + penalty[nr, nc])
                if nd < dist[nr, nc]:
                    dist[nr, nc] = nd
                    prev[(nr, nc)] = (r, c)
                    heapq.heappush(heap, (nd, (nr, nc)))
        path, node = [], goal
        while node != start:
            path.append(node)
            node = prev[node]
        path.append(start)
        path.reverse()
        pts = [self.to_latlon(r, c) for r, c in path]
        pts[0], pts[-1] = a, b
        return pts

    def sample(self, lat: float, lon: float) -> dict:
        col, row = ~self.tf * (lon, lat)
        r, c = int(row), int(col)
        # quota: interpolazione bilineare
        fr, fc = row - r, col - c
        z = self.z
        ele = ((1 - fr) * ((1 - fc) * z[r, c] + fc * z[r, c + 1])
               + fr * ((1 - fc) * z[r + 1, c] + fc * z[r + 1, c + 1]))
        rr, cc = int(round(row)), int(round(col))
        asp = float(self.aspect[rr, cc])
        return {
            "ele": round(float(ele), 1),
            "slope": round(float(self.slope[rr, cc]), 1),
            "slope_max": round(float(self.slope_max[rr, cc]), 1),
            "aspect_deg": round(asp),
            "aspect": SECTORS[int(((asp + 22.5) % 360) // 45)],
        }


def build_track(route: dict, cfg: dict) -> tuple[list[dict], dict]:
    tr = route["track"]
    if "gpx_url" in tr:
        raw = get(tr["gpx_url"], cache_name=f"gpx/{route['id']}.gpx", as_json=False)
        pts = read_gpx(raw)
        source = "gpx"
    else:
        pts = [(w[0], w[1]) for w in tr["waypoints"]]
        source = "waypoints"
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    dem = Dem(cfg["dem"]["tile_url"], lats, lons, margin=cfg["dem"].get("margin_deg", 0.01))
    if source == "gpx":
        # La traccia GPX contiene salita e discesa: si taglia alla quota massima (vetta).
        eles = [dem.sample(la, lo)["ele"] for la, lo in pts[:: max(1, len(pts) // 2000)]]
        k = int(np.argmax(eles)) * max(1, len(pts) // 2000)
        pts = pts[: k + 1]
    elif tr.get("snap_to_terrain"):
        # Traccia stimata: percorso a costo minimo sul DEM tra waypoint consecutivi.
        snapped = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            snapped += dem.least_cost_path(a, b)[1:]
        pts = snapped
        source = "waypoints+dem"
    pts = resample(pts, cfg["dem"]["sample_step_m"])
    out, dist = [], 0.0
    for i, (la, lo) in enumerate(pts):
        if i:
            dist += haversine(pts[i - 1][0], pts[i - 1][1], la, lo)
        s = dem.sample(la, lo)
        out.append({"lat": round(la, 6), "lon": round(lo, 6), "d": round(dist), **s})
    # la salita finisce nel punto più alto (il DEM può non coincidere con la vetta OSM/GPX)
    top = max(range(len(out)), key=lambda i: out[i]["ele"])
    out = out[: top + 1]
    dist = out[-1]["d"]
    eles = [p["ele"] for p in out]
    gain = sum(max(0.0, b - a) for a, b in zip(eles, eles[1:]))
    steep = [p for p in out if p["slope_max"] >= 30]
    asp_count = {s: 0 for s in SECTORS}
    for p in out:
        asp_count[p["aspect"]] += 1
    stats = {
        "track_source": source,
        "length_m": round(dist),
        "gain_m": round(gain),
        "start_ele": round(eles[0]),
        "summit_ele": round(max(eles)),
        "max_slope": round(max(p["slope_max"] for p in out), 1),
        "steep_share": round(len(steep) / len(out), 3),
        "aspects": {k: round(v / len(out), 3) for k, v in asp_count.items()},
    }
    log(f"  traccia {source}: {len(out)} punti, {stats['length_m']} m, D+ {stats['gain_m']} m, "
        f"pendenza max {stats['max_slope']}°")
    return out, stats, dem


# --------------------------------------------------------------------------- SIVA (Arpa Piemonte)

# categoria → suffisso del file per provincia (es. TO/to_valterreno.shp)
SIVA_LAYERS = [("doc", "valterreno"), ("astv", "astv"), ("zone", "zoneper"), ("foto", "valfoto")]
SIVA_EVENTS = "(val_)?infostoriche"


def _siva_reader(zf, prov: str, suffix: str):
    import io
    import re
    import shapefile
    names = {n.lower(): n for n in zf.namelist()}
    pat = re.compile(rf"^{prov}/{prov}_{suffix}\.shp$", re.I)
    shp = next((n for n in zf.namelist() if pat.match(n)), None)
    if not shp:
        return None
    base = shp[:-4].lower()
    part = lambda ext: io.BytesIO(zf.read(names[base + ext]))
    return shapefile.Reader(shp=part(".shp"), shx=part(".shx"), dbf=part(".dbf"), encoding="utf-8")


def _round_geom(geom, nd: int = 6) -> dict:
    def r(c):
        return [r(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], nd), round(c[1], nd)]
    m = mapping(geom)
    return {"type": m["type"], "coordinates": r(m["coordinates"])}


def _siva_props(cat: str, a: dict) -> dict:
    """Attributi utili per categoria (chiavi dei DBF in minuscolo)."""
    clean = lambda v: (" ".join(str(v).split()) or None) if v not in (None, "") else None
    p = {"comune": clean(a.get("comune")), "link": clean(a.get("link"))}
    if cat == "doc":
        p.update(name=clean(a.get("denosito")) or clean(a.get("localita")), place=clean(a.get("localita")),
                 method=clean(a.get("modacq")), code=clean(a.get("code_cate")))
    elif cat == "astv":
        p.update(name=clean(a.get("nome_valan")), date=clean(a.get("data")),
                 caught=clean(a.get("travolti")), dead=clean(a.get("morti")))
    elif cat == "zone":
        p.update(method=clean(a.get("modacq")))
    else:
        p.update(place=clean(a.get("d_tavola")))
    return {k: v for k, v in p.items() if v is not None}


def build_siva(route: dict, track: list[dict], dem: "Dem", cfg: dict) -> dict:
    """Siti valanghivi SIVA nell'area della gita e tratti di traccia che li attraversano.

    Scrive siva_<id>.geojson (WGS84) e aggiunge a ogni punto della traccia `sv`:
    gli id dei siti entro `buffer_m`. Solo informativo: non cambia il rischio.
    """
    import io
    import zipfile
    import shapely
    from pyproj import Transformer
    from shapely.geometry import LineString, box
    from shapely.ops import transform

    s = cfg["siva"]
    raw = get(s["zip_url"], cache_name="siva/valanghe.zip", as_json=False)
    zf = zipfile.ZipFile(io.BytesIO(raw))
    to_utm = Transformer.from_crs(4326, 32632, always_xy=True).transform
    to_wgs = Transformer.from_crs(32632, 4326, always_xy=True).transform
    win = transform(to_utm, box(*dem.bounds))
    pts = [Point(to_utm(p["lon"], p["lat"])) for p in track]
    prov = route["province"]

    feats, sites = [], []
    for cat, suffix in SIVA_LAYERS:
        rd = _siva_reader(zf, prov, suffix)
        if rd is None:
            continue
        for sr in rd.iterShapeRecords(bbox=list(win.bounds)):
            g = shape(sr.shape.__geo_interface__)
            if not g.is_valid:
                g = g.buffer(0)
            if g.is_empty or not g.intersects(win):
                continue
            a = {k.lower(): v for k, v in sr.record.as_dict().items()}
            props = {"id": f"{cat}{len(feats)}", "cat": cat, **_siva_props(cat, a)}
            near = g.buffer(s["buffer_m"])
            shapely.prepare(near)
            idx = [i for i, p in enumerate(pts) if near.contains(p)]
            if idx:
                inside = set(idx)
                props["track_m"] = round(sum(track[i]["d"] - track[i - 1]["d"] for i in idx if i - 1 in inside))
                props["from_d"] = track[idx[0]]["d"]
                props["ele"] = [round(min(track[i]["ele"] for i in idx)), round(max(track[i]["ele"] for i in idx))]
                for i in idx:
                    track[i].setdefault("sv", []).append(props["id"])
                sites.append(props)
            feats.append({"type": "Feature", "properties": props,
                          "geometry": _round_geom(transform(to_wgs, g.simplify(3)))})

    events = []
    rd = _siva_reader(zf, prov, SIVA_EVENTS)
    line = LineString([(p.x, p.y) for p in pts])
    if rd is not None:
        for sr in rd.iterShapeRecords(bbox=list(win.bounds)):
            g = shape(sr.shape.__geo_interface__)
            dist = line.distance(g)
            if dist > s["events_radius_m"]:
                continue
            a = {k.lower(): v for k, v in sr.record.as_dict().items()}
            ev = {"id": f"ev{len(events)}", "cat": "event", "name": a.get("localita") or None,
                  "comune": a.get("comune") or None, "date": a.get("data_eve") or None,
                  "link": a.get("link") or None, "dist_m": round(dist)}
            ev = {k: v for k, v in ev.items() if v is not None}
            events.append(ev)
            feats.append({"type": "Feature", "properties": ev, "geometry": _round_geom(transform(to_wgs, g))})

    name = f"siva_{route['id']}.geojson"
    (OUT / name).write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                       ensure_ascii=False, separators=(",", ":")))
    counts = {cat: sum(1 for f in feats if f["properties"]["cat"] == cat) for cat, _ in SIVA_LAYERS}
    sites.sort(key=lambda x: x["from_d"])
    log(f"  SIVA: {len(feats)} oggetti nell'area {counts}, {len(sites)} siti sulla traccia, "
        f"{len(events)} eventi entro {s['events_radius_m']} m")
    return {"file": name, "sites": sites, "events": events, "counts": counts}


# --------------------------------------------------------------------------- meteo

def build_meteo(route_id: str, lat: float, lon: float, ele: float, tag: str,
                cfg: dict, first: dt.date, last: dt.date) -> dict:
    m = cfg["meteo"]
    params = {
        "latitude": round(lat, 4), "longitude": round(lon, 4), "elevation": round(ele),
        "start_date": first.isoformat(), "end_date": last.isoformat(),
        "hourly": ",".join(m["hourly"]), "timezone": "Europe/Rome",
    }
    data = get(m["url"], params=params, cache_name=f"meteo/{route_id}_{tag}_{first}_{last}.json")
    h = data["hourly"]
    daily = []
    for day in daterange(first, last):
        ds = day.isoformat()
        idx = [i for i, t in enumerate(h["time"]) if t.startswith(ds)]
        day_idx = [i for i in idx if 8 <= int(h["time"][i][11:13]) <= 16]   # ore di gita

        def col(name, ii=idx):
            return [h[name][i] for i in ii if h[name][i] is not None]

        wd = col("wind_direction_10m", day_idx)
        ws = col("wind_speed_10m", day_idx)
        if wd:
            u = sum(s * math.sin(math.radians(d)) for s, d in zip(ws, wd))
            v = sum(s * math.cos(math.radians(d)) for s, d in zip(ws, wd))
            wdir = SECTORS[int(((math.degrees(math.atan2(u, v)) + 360 + 22.5) % 360) // 45)]
        else:
            wdir = None
        daily.append({
            "date": ds,
            "snowfall_cm": round(sum(col("snowfall")), 1),
            "precip_mm": round(sum(col("precipitation")), 1),
            "rain_mm": round(sum(col("rain")), 1),
            "t_min": round(min(col("temperature_2m")), 1),
            "t_max": round(max(col("temperature_2m")), 1),
            "wind_max": round(max(col("wind_speed_10m")), 0),
            "gust_max": round(max(col("wind_gusts_10m")), 0),
            "wind_day": round(max(ws), 0) if ws else None,
            "wind_dir_day": wdir,
            "freezing_max": round(max(col("freezing_level_height"))),
            "freezing_min": round(min(col("freezing_level_height"))),
            "cloud_day": round(sum(col("cloud_cover", day_idx)) / max(1, len(day_idx))),
            "snow_depth_m": round(col("snow_depth")[-1], 2) if col("snow_depth") else None,
        })
    hourly = {k: h[k] for k in ("time", "temperature_2m", "snowfall", "wind_speed_10m",
                                 "wind_gusts_10m", "freezing_level_height")}
    return {"lat": data["latitude"], "lon": data["longitude"], "elevation": ele,
            "daily": daily, "hourly": hourly}


# --------------------------------------------------------------------------- main

def main() -> int:
    cfg = yaml.safe_load((HERE / "config.yaml").read_text())
    w = cfg["window"]
    start, end = dt.date.fromisoformat(w["start"]), dt.date.fromisoformat(w["end"])
    first = start - dt.timedelta(days=w["history_days"])
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    log(f"finestra {start} → {end} (storico da {first})")
    bulletins = build_bulletins(cfg, first, end)
    regions, region_shapes = build_regions(cfg)

    routes = []
    for r in cfg["routes"]:
        log(f"gita {r['name']}")
        track, stats, dem = build_track(r, cfg)
        summit = max(track, key=lambda p: p["ele"])
        start_pt = track[0]
        region = next((rid for rid, geom in region_shapes
                       if geom.contains(Point(summit["lon"], summit["lat"]))), None)
        log(f"  micro-regione {region}")
        meteo = {
            "start": build_meteo(r["id"], start_pt["lat"], start_pt["lon"], start_pt["ele"],
                                 "start", cfg, first, end),
            "summit": build_meteo(r["id"], summit["lat"], summit["lon"], summit["ele"],
                                  "summit", cfg, first, end),
        }
        siva = build_siva(r, track, dem, cfg) if cfg.get("siva") else None
        grid = dem.export_grid()
        (OUT / f"grid_{r['id']}.json").write_text(json.dumps(grid, separators=(",", ":")))
        log(f"  griglia 3D {grid['w']}x{grid['h']} celle")
        routes.append({
            "id": r["id"], "name": r["name"], "valley": r["valley"], "province": r["province"],
            "municipality": r["municipality"], "difficulty": r["difficulty"],
            "gulliver_url": r["gulliver_url"], "gulliver_aspect": r["gulliver_aspect"],
            "gulliver_gain_m": r["gulliver_gain_m"], "description": " ".join(r["description"].split()),
            "start_name": r["start_name"], "summit_name": r["summit_name"],
            "region": region, "stats": stats, "track": track, "meteo": meteo, "siva": siva,
            "waypoints": [{"lat": wp[0], "lon": wp[1], "name": wp[2]}
                          for wp in r["track"].get("waypoints", []) if wp[2]],
            "reports": sorted(r.get("reports", []), key=lambda x: x["date"], reverse=True),
        })

    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "window": {"start": start.isoformat(), "end": end.isoformat(), "first": first.isoformat()},
        "treeline_m": cfg["aineva"]["treeline_m"],
        "sources": {
            "bulletins": "AINEVA – bollettini valanghe CAAML v6 (bollettini.aineva.it)",
            "regions": "EAWS micro-regions (regions.avalanches.org)",
            "meteo": "Open-Meteo Historical Forecast API",
            "dem": "Copernicus DEM GLO-30",
            "routes": "Gulliver.it (metadati e relazioni inseriti a mano)",
            "siva": "Arpa Piemonte – SIVA, Sistema Informativo Valanghe (CC BY 4.0)",
        },
    }

    def dump(name, obj):
        (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        log(f"scritto {OUT / name} ({(OUT / name).stat().st_size // 1024} KB)")

    dump("meta.json", meta)
    dump("bulletins.json", bulletins)
    dump("regions.geojson", regions)
    dump("routes.json", routes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
