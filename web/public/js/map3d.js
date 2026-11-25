// Zefiro – vista 3D (MapLibre GL JS + terreno Terrarium).
//
// Livelli: mappa di base (topo/satellite), ombreggiatura, sovrapposizione calcolata
// nel browser dalla griglia DEM della gita (bollettino sul terreno o classi di
// pendenza), traccia colorata per rischio. API compatibile con la mappa 2D.
import { SECTORS, problemsAt } from "./engine.js";
import { showTip, hideTip, pointTip, SIVA, sivaName, sivaPopup } from "./charts.js";

const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const EXAGGERATION = 1.3;
const RISK_COLORS = { low: "#1f8a4c", mid: "#c98a00", high: "#c62f2f" };

// colori RGBA della sovrapposizione
const SLOPE_RGBA = [
  [30, [246, 215, 67, 170]],
  [35, [240, 140, 44, 185]],
  [40, [212, 60, 60, 200]],
  [45, [142, 63, 163, 210]],
];
const CRIT_RGBA = [
  [30, [255, 120, 90, 150]],
  [35, [235, 60, 40, 185]],
  [40, [170, 0, 30, 215]],
];

let lastCamera = null;   // { routeId, center, zoom, bearing, pitch }

// ------------------------------------------------------------------ griglia

function b64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeGrid(g) {
  if (g._decoded) return g;
  const eb = b64(g.ele);
  g.eleArr = new Int16Array(eb.buffer, eb.byteOffset, eb.length / 2);
  g.slopeArr = b64(g.slope);
  g.aspectArr = b64(g.aspect);
  g._decoded = true;
  return g;
}

const pick = (table, v) => {
  let c = null;
  for (const [min, rgba] of table) if (v >= min) c = rgba;
  return c;
};

/** Disegna la sovrapposizione su un canvas (una cella DEM = un pixel). */
function drawOverlay(grid, bull, mode) {
  const cv = document.createElement("canvas");
  cv.width = grid.w; cv.height = grid.h;
  if (mode === "none") return cv;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(grid.w, grid.h);
  const cache = new Map();   // (fascia quota, settore) → critico?
  for (let i = 0; i < grid.w * grid.h; i++) {
    const s = grid.slopeArr[i];
    if (s < 30) continue;
    let rgba;
    if (mode === "slope") rgba = pick(SLOPE_RGBA, s);
    else {
      const ele = grid.eleArr[i], asp = grid.aspectArr[i];
      const key = (ele / 50 | 0) * 8 + asp;
      let crit = cache.get(key);
      if (crit === undefined) {
        crit = problemsAt(bull, ele, SECTORS[asp]).length > 0;
        cache.set(key, crit);
      }
      if (!crit) continue;
      rgba = pick(CRIT_RGBA, s);
    }
    img.data.set(rgba, i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// ------------------------------------------------------------------ geometria

const toRad = (d) => (d * Math.PI) / 180;
function bearing(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function segmentsGeoJSON(points) {
  const features = [];
  let s = 0;
  for (let i = 1; i <= points.length; i++) {
    if (i === points.length || points[i].rc !== points[s].rc) {
      features.push({
        type: "Feature", properties: { color: RISK_COLORS[points[s].rc] },
        geometry: { type: "LineString", coordinates: points.slice(s, Math.min(i + 1, points.length)).map((p) => [p.lon, p.lat]) },
      });
      s = i;
    }
  }
  return { type: "FeatureCollection", features };
}

function dotEl(cls) {
  const d = document.createElement("div");
  d.className = `m3d-dot ${cls}`;
  return d;
}

// ------------------------------------------------------------------ mappa

/**
 * @param container elemento DOM
 * @param a analisi della gita (engine.analyzeRoute)
 * @param grid griglia DEM decodificata
 * @param opts { overlay: "bulletin"|"slope"|"none", base: "topo"|"sat", onHover(p) }
 */
export function render3D(container, a, grid, opts) {
  const { route, points, bull } = a;
  const [w, s, e, n] = grid.bounds;
  const coords = [[w, n], [e, n], [e, s], [w, s]];

  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        topo: {
          type: "raster", tileSize: 256, maxzoom: 17,
          tiles: ["a", "b", "c"].map((sub) => `https://${sub}.tile.opentopomap.org/{z}/{x}/{y}.png`),
          attribution: "© OpenStreetMap, SRTM · OpenTopoMap (CC-BY-SA)",
        },
        sat: {
          type: "raster", tileSize: 256, maxzoom: 18,
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
        },
        dem: { type: "raster-dem", tiles: [TERRARIUM], encoding: "terrarium", tileSize: 256, maxzoom: 15,
          attribution: "Terreno: Mapzen Terrarium (AWS Open Data)" },
        hs: { type: "raster-dem", tiles: [TERRARIUM], encoding: "terrarium", tileSize: 256, maxzoom: 15 },
      },
      layers: [
        { id: "topo", type: "raster", source: "topo", layout: { visibility: opts.base === "sat" ? "none" : "visible" } },
        { id: "sat", type: "raster", source: "sat", layout: { visibility: opts.base === "sat" ? "visible" : "none" } },
        { id: "hillshade", type: "hillshade", source: "hs", paint: { "hillshade-exaggeration": 0.3, "hillshade-shadow-color": "#1d2b38" } },
      ],
      terrain: { source: "dem", exaggeration: EXAGGERATION },
    },
    maxPitch: 80,
    attributionControl: { compact: true },
  });
  map.scrollZoom.disable();
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.FullscreenControl(), "top-right");

  // camera: ripristina quella precedente sulla stessa gita, altrimenti guarda dalla partenza verso la vetta
  const start = points[0], top = points[points.length - 1];
  if (lastCamera?.routeId === route.id) {
    map.jumpTo(lastCamera);
  } else {
    const b = new maplibregl.LngLatBounds();
    points.forEach((p) => b.extend([p.lon, p.lat]));
    const cam = map.cameraForBounds(b, { padding: 60 });
    map.jumpTo({ ...cam, zoom: (cam?.zoom ?? 13) - 0.3, pitch: 62, bearing: bearing(start, top) });
  }
  const saveCamera = () => {
    lastCamera = { routeId: route.id, center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  };
  map.on("moveend", saveCamera);

  let overlayMode = opts.overlay;
  let currentBull = bull;

  map.on("load", () => {
    map.addSource("overlay", { type: "image", url: drawOverlay(grid, currentBull, overlayMode).toDataURL(), coordinates: coords });
    map.addLayer({ id: "overlay", type: "raster", source: "overlay", paint: { "raster-opacity": 0.85, "raster-resampling": "nearest", "raster-fade-duration": 0 } });
    if (opts.siva) addSiva();
    map.addSource("track", { type: "geojson", data: segmentsGeoJSON(points) });
    map.addLayer({ id: "track-casing", type: "line", source: "track", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 8, "line-opacity": 0.9 } });
    map.addLayer({ id: "track", type: "line", source: "track", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 4.5 } });
    map.addLayer({ id: "track-hit", type: "line", source: "track", paint: { "line-color": "#000", "line-width": 22, "line-opacity": 0 } });

    map.on("mousemove", "track-hit", (ev) => {
      let best = points[0], bd = Infinity;
      for (const p of points) {
        const d = (p.lat - ev.lngLat.lat) ** 2 + ((p.lon - ev.lngLat.lng) * 0.7) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      api.mark(best);
      opts.onHover?.(best);
      showTip(pointTip(best), ev.originalEvent.clientX, ev.originalEvent.clientY);
      map.getCanvas().style.cursor = "crosshair";
    });
    map.on("mouseleave", "track-hit", () => {
      api.mark(null); opts.onHover?.(null); hideTip();
      map.getCanvas().style.cursor = "";
    });
  });

  // ---------------------------------------------------------------- siti valanghivi SIVA
  const SIVA_LAYERS = ["siva-fill", "siva-line-doc", "siva-line-zone", "siva-line-foto", "siva-event"];
  const catColor = ["match", ["get", "cat"], ...["doc", "astv", "zone", "foto"].flatMap((c) => [c, SIVA[c].color]), SIVA.doc.color];
  const isCat = (...c) => ["in", ["get", "cat"], ["literal", c]];
  function addSiva() {
    const vis = opts.showSiva ? "visible" : "none";
    map.addSource("siva", { type: "geojson", data: opts.siva });
    map.addLayer({ id: "siva-fill", type: "fill", source: "siva", filter: ["!=", ["get", "cat"], "event"], layout: { visibility: vis },
      paint: { "fill-color": catColor, "fill-opacity": ["case", ["has", "track_m"], 0.38, 0.2] } });
    const line = (id, cats, extra) => map.addLayer({ id, type: "line", source: "siva", filter: isCat(...cats), layout: { visibility: vis },
      paint: { "line-color": catColor, "line-width": ["case", ["has", "track_m"], 2.4, 1.4], ...extra } });
    line("siva-line-doc", ["doc", "astv"], {});
    line("siva-line-zone", ["zone"], { "line-dasharray": [3, 2] });
    line("siva-line-foto", ["foto"], { "line-dasharray": [1, 2] });
    map.addLayer({ id: "siva-event", type: "circle", source: "siva", filter: ["==", ["get", "cat"], "event"], layout: { visibility: vis },
      paint: { "circle-radius": 6, "circle-color": SIVA.event.color, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
    const popup = new maplibregl.Popup({ maxWidth: "280px" });
    for (const id of ["siva-fill", "siva-event"]) {
      map.on("click", id, (ev) => {
        // la traccia ha la precedenza: niente popup se il clic è sulla traccia
        if (map.queryRenderedFeatures(ev.point, { layers: ["track-hit"] }).length) return;
        const f = ev.features[0];
        const props = { ...f.properties };
        if (typeof props.ele === "string") props.ele = JSON.parse(props.ele);   // MapLibre serializza gli array
        popup.setLngLat(ev.lngLat).setHTML(sivaPopup(props)).addTo(map);
      });
      map.on("mouseenter", id, (ev) => { map.getCanvas().style.cursor = "pointer"; map.getCanvas().title = sivaName(ev.features[0].properties); });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; map.getCanvas().title = ""; });
    }
  }

  new maplibregl.Marker({ element: dotEl("m3d-start") }).setLngLat([start.lon, start.lat])
    .setPopup(new maplibregl.Popup({ offset: 10, closeButton: false }).setText(`Partenza · ${route.start_name} ${Math.round(start.ele)} m`)).addTo(map);
  new maplibregl.Marker({ element: dotEl("m3d-summit") }).setLngLat([top.lon, top.lat])
    .setPopup(new maplibregl.Popup({ offset: 10, closeButton: false }).setText(`Vetta · ${route.summit_name} ${Math.round(top.ele)} m`)).addTo(map);
  const cursor = new maplibregl.Marker({ element: dotEl("m3d-cursor") });

  // ---------------------------------------------------------------- volo lungo la traccia
  let flight = null;
  function stopFlight() {
    if (!flight) return;
    cancelAnimationFrame(flight.raf);
    flight = null;
    api.mark(null); opts.onHover?.(null);
    opts.onFlight?.(false);
  }
  function fly() {
    if (flight) { stopFlight(); return; }
    const total = 28000;   // ms
    let b0 = map.getBearing();
    const t0 = performance.now();
    flight = { raf: 0 };
    opts.onFlight?.(true);
    const step = (now) => {
      if (!flight) return;
      const t = Math.min(1, (now - t0) / total);
      const f = t * (points.length - 1), i = Math.floor(f), k = f - i;
      const p0 = points[i], p1 = points[Math.min(i + 1, points.length - 1)];
      const p = { ...p0, lat: p0.lat + (p1.lat - p0.lat) * k, lon: p0.lon + (p1.lon - p0.lon) * k };
      const ahead = points[Math.min(points.length - 1, i + 14)];
      const back = points[Math.max(0, i - 6)];
      let target = ahead === p0 ? b0 : bearing(back, ahead);
      let delta = ((target - b0 + 540) % 360) - 180;
      b0 += delta * 0.04;   // rotazione morbida
      map.jumpTo({ center: [p.lon, p.lat], bearing: b0, pitch: 66, zoom: 14.4 });
      api.mark(p0); opts.onHover?.(p0);
      if (t < 1) flight.raf = requestAnimationFrame(step);
      else stopFlight();
    };
    flight.raf = requestAnimationFrame(step);
  }
  ["mousedown", "touchstart", "wheel"].forEach((ev) => map.getCanvasContainer().addEventListener(ev, stopFlight, { passive: true }));

  const api = {
    kind: "3d",
    mark(p) {
      if (!p) { cursor.remove(); return; }
      cursor.setLngLat([p.lon, p.lat]).addTo(map);
    },
    setOverlay(mode, newBull = currentBull) {
      overlayMode = mode; currentBull = newBull;
      const src = map.getSource("overlay");
      if (src) src.updateImage({ url: drawOverlay(grid, currentBull, overlayMode).toDataURL(), coordinates: coords });
    },
    setBase(base) {
      map.setLayoutProperty("topo", "visibility", base === "sat" ? "none" : "visible");
      map.setLayoutProperty("sat", "visibility", base === "sat" ? "visible" : "none");
    },
    setSiva(on) {
      if (!map.getSource("siva")) { opts.showSiva = on; return; }
      SIVA_LAYERS.forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    },
    fly,
    destroy() { stopFlight(); saveCamera(); map.remove(); },
  };
  return api;
}

export function legend3D(mode) {
  if (mode === "slope") return `<div class="legend">
    <span><i style="background:rgb(246,215,67)"></i>30–35°</span><span><i style="background:rgb(240,140,44)"></i>35–40°</span>
    <span><i style="background:rgb(212,60,60)"></i>40–45°</span><span><i style="background:rgb(142,63,163)"></i>&gt; 45°</span></div>`;
  if (mode === "bulletin") return `<div class="legend">
    <span>Pendii ≥ 30° con quota ed esposizione indicate nel bollettino del giorno:</span>
    <span><i style="background:rgb(255,120,90)"></i>30–35°</span><span><i style="background:rgb(235,60,40)"></i>35–40°</span>
    <span><i style="background:rgb(170,0,30)"></i>&gt; 40°</span></div>`;
  return "";
}
