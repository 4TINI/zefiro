// Zefiro – mappa di esplorazione (stile mappa/lista): un segnaposto per gita
// con punteggio e giudizio del giorno, micro-regioni colorate per pericolo.
import { DANGER, VERDICT, bulletinFor, fmtDay } from "./engine.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let lastView = null;   // { center, zoom } tra un render e l'altro

/**
 * @param el contenitore della mappa
 * @param ctx {
 *   analyses: analisi delle gite che rispettano i filtri,
 *   excluded: [{ r, why }], date, bulletins, regions, regionNames,
 *   fitTo: LatLngBounds-like [[s,w],[n,e]] | null  (forza l'inquadratura),
 *   onHover(id|null), onMove(bounds)
 * }
 */
export function renderExplore(el, ctx) {
  const map = L.map(el, { scrollWheelZoom: true, zoomControl: true });
  // inquadratura PRIMA dei layer vettoriali: forzata dal filtro area,
  // altrimenti la precedente, altrimenti tutte le gite
  const starts = [...ctx.analyses.map((a) => a.route), ...ctx.excluded.map((e) => e.r)]
    .map((r) => [r.track[0].lat, r.track[0].lon]);
  const frame = () => {
    if (ctx.fitTo) map.fitBounds(ctx.fitTo, { padding: [40, 40], maxZoom: 12 });
    else if (lastView) map.setView(lastView.center, lastView.zoom);
    else if (starts.length) map.fitBounds(L.latLngBounds(starts).pad(0.6), { maxZoom: 11 });
    else map.fitBounds(L.geoJSON(ctx.regions).getBounds());
  };
  // su mobile la mappa può nascere nascosta (dimensione 0): si inquadra quando diventa visibile
  let framed = el.clientWidth > 0;
  if (framed) frame();
  else map.setView([45, 7.3], 8);
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, attribution: "© OpenStreetMap, SRTM · OpenTopoMap (CC-BY-SA)",
  }).addTo(map);

  // micro-regioni colorate per pericolo del giorno
  const regionLayer = L.geoJSON(ctx.regions, {
    style: (f) => {
      const lv = bulletinFor(ctx.bulletins, ctx.date, f.properties.id)?.max_level ?? 0;
      return { color: "#3c5068", weight: 1.2, fillColor: lv ? DANGER[lv].color : "#999", fillOpacity: 0.32 };
    },
    onEachFeature: (f, layer) => {
      const lv = bulletinFor(ctx.bulletins, ctx.date, f.properties.id)?.max_level ?? 0;
      layer.bindTooltip(`${esc(ctx.regionNames[f.properties.id])} · pericolo ${lv ? DANGER[lv].label : "–"}`, { sticky: true });
    },
  }).addTo(map);

  const markers = new Map();   // id → { marker, track }
  const addRoute = (route, a, why) => {
    const start = route.track[0];
    const v = a?.verdict;
    const html = a
      ? `<div class="pin pin-${v}"><span class="pin-ic">${VERDICT[v].icon}</span><b>${a.score}</b></div>`
      : `<div class="pin pin-off"><span class="pin-ic">–</span></div>`;
    const marker = L.marker([start.lat, start.lon], {
      icon: L.divIcon({ className: "pin-wrap", html, iconSize: null, iconAnchor: [0, 0] }),
      riseOnHover: true, keyboard: true, title: route.name,
    }).addTo(map);
    const track = L.polyline(route.track.map((p) => [p.lat, p.lon]), {
      color: "#0b2239", weight: 4, opacity: 0, interactive: false,
    }).addTo(map);
    marker.bindPopup(popupHtml(route, a, why, ctx), { maxWidth: 280, offset: [20, 0] });
    marker.on("mouseover", () => { highlight(route.id); ctx.onHover?.(route.id); });
    marker.on("mouseout", () => { highlight(null); ctx.onHover?.(null); });
    markers.set(route.id, { marker, track });
  };
  ctx.analyses.forEach((a) => addRoute(a.route, a, null));
  ctx.excluded.forEach((e) => addRoute(e.r, null, e.why));

  function highlight(id) {
    for (const [rid, m] of markers) {
      const on = rid === id;
      m.track.setStyle({ opacity: on ? 0.9 : 0 });
      m.marker.getElement()?.classList.toggle("pin-active", on);
      if (on) m.marker.setZIndexOffset(1000); else m.marker.setZIndexOffset(0);
    }
  }

  map.on("moveend", () => {
    if (!framed || el.clientWidth === 0) return;   // mappa nascosta (vista lista su mobile)
    lastView = { center: map.getCenter(), zoom: map.getZoom() };
    ctx.onMove?.(map.getBounds());
  });
  // prima notifica dopo il layout
  setTimeout(() => { map.invalidateSize(); if (framed) ctx.onMove?.(map.getBounds()); }, 0);

  return {
    highlight,
    invalidate() {
      if (el.clientWidth === 0) return;
      map.invalidateSize();
      if (!framed && el.clientWidth > 0) { framed = true; frame(); }
    },
    destroy() { if (framed) lastView = { center: map.getCenter(), zoom: map.getZoom() }; map.remove(); },
  };
}

function popupHtml(route, a, why, ctx) {
  const head = `<div class="pop-name">${esc(route.name)}</div>
    <div class="pop-meta">${esc(route.valley)} · D+ ${route.stats.gain_m} m · ${(route.stats.length_m / 1000).toFixed(1)} km · ${route.difficulty}</div>`;
  if (!a) return `${head}<div class="pop-meta">Esclusa dai filtri: ${esc(why.join(", "))}</div>`;
  const d = DANGER[a.maxDanger];
  return `${head}
    <div class="pop-badges">
      <span class="badge verdict-${a.verdict}"><span class="icon-dot"><span>${VERDICT[a.verdict].icon}</span></span>${VERDICT[a.verdict].label}</span>
      ${d ? `<span class="badge danger-badge" style="background:${d.color};color:${d.ink}">Pericolo ${d.label}</span>` : ""}
    </div>
    <div class="pop-meta">Neve: ${esc(a.snow.top)}</div>
    <div class="pop-meta">${a.exposure ? `${Math.round(a.exposure)} m oltre soglia` : "Nessun tratto oltre soglia"} · punteggio ${a.score}/100</div>
    ${route.siva?.sites?.length ? `<div class="pop-meta">Storico: ${route.siva.sites.length} siti valanghivi sulla traccia (Arpa SIVA)</div>` : ""}
    <a class="btn pop-btn" href="#/gita/${route.id}/${ctx.date}">Apri radiografia →</a>`;
}

export function exploreLegend() {
  return `<div class="legend">
    <span><span class="pin pin-go pin-mini"><span class="pin-ic">✓</span></span>Consigliata</span>
    <span><span class="pin pin-caution pin-mini"><span class="pin-ic">!</span></span>Con cautela</span>
    <span><span class="pin pin-no pin-mini"><span class="pin-ic">✕</span></span>Sconsigliata</span>
    <span><span class="pin pin-off pin-mini"><span class="pin-ic">–</span></span>Esclusa dai filtri</span>
    <span>· numero = punteggio del giorno · aree colorate = pericolo della micro-regione</span>
  </div>`;
}


