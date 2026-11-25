// Zefiro – interfaccia del prototipo.
import {
  DANGER, PROBLEMS, GROUP_FACTORS, VERDICT, addDays, fmtDay, analyzeRoute,
  bulletinFor, dangerBands, evolutionText,
} from "./engine.js";
import {
  renderProfile, profileLegend, renderMeteo, aspectRose, showTip, hideTip, pointTip,
  SIVA, sivaName, sivaPopup, sivaLegend,
} from "./charts.js";
import { render3D, decodeGrid, legend3D } from "./map3d.js";
import { renderExplore, exploreLegend } from "./explore.js";

const DIFF_ORDER = ["MS", "BS", "BSA", "OS", "OSA"];
const $ = (s, root = document) => root.querySelector(s);
const rich = (s) => (s == null ? "–" : esc(s).replace(/&lt;br\s*\/?&gt;/g, "<br>"));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  data: null,
  date: null,
  routeId: null,
  view: "explore",          // "explore" (mappa + lista) | "detail" (radiografia)
  mapBounds: null,          // area visibile della mappa di esplorazione
  searchOnMove: true,       // la lista segue la mappa (stile mappa/lista)
  fitArea: true,            // ricentra la mappa al prossimo render (cambio area)
  mobilePane: "list",
  filters: { area: "all", gain: 1800, length: 12, diff: "BSA", group: "small" },
};
let map = null;          // Leaflet (2D)
let mapApi = null;       // API comune 2D/3D: mark(p), destroy()
let profileApi = null;
let exploreApi = null;
const grids = {};
const sivaCache = {};

// preferenze della mappa, ricordate nel browser (se possibile)
const mapPrefs = (() => {
  const def = { mode: "2d", overlay: "bulletin", base: "topo", siva: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem("zefiro.map") || "{}") }; } catch { return def; }
})();
const saveMapPrefs = () => { try { localStorage.setItem("zefiro.map", JSON.stringify(mapPrefs)); } catch { /* ignora */ } };
const webglOk = (() => {
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
})();

// ------------------------------------------------------------------ dati

async function load() {
  const get = (f) => fetch(`data/${f}`).then((r) => {
    if (!r.ok) throw new Error(`${f}: ${r.status}`);
    return r.json();
  });
  const [meta, bulletins, regions, routes] = await Promise.all(
    ["meta.json", "bulletins.json", "regions.geojson", "routes.json"].map(get));
  routes.forEach(prepareSiva);
  const regionNames = Object.fromEntries(regions.features.map((f) => [f.properties.id, f.properties.name]));
  const windowDays = [];
  for (let d = meta.window.start; d <= meta.window.end; d = addDays(d, 1)) windowDays.push(d);
  const allDays = [];
  for (let d = meta.window.first; d <= meta.window.end; d = addDays(d, 1)) allDays.push(d);
  return { meta, bulletins, regions, routes, regionNames, windowDays, allDays };
}

// Collega ai punti della traccia i siti SIVA che li contengono e somma i metri per categoria.
// doc e astv contano insieme come "valanghe documentate".
const sivaGroup = (cat) => (cat === "astv" ? "doc" : cat);
function prepareSiva(route) {
  const sites = route.siva?.sites ?? [];
  const byId = Object.fromEntries(sites.map((x) => [x.id, x]));
  const stats = { doc: { n: 0, m: 0 }, zone: { n: 0, m: 0 }, foto: { n: 0, m: 0 } };
  sites.forEach((x) => stats[sivaGroup(x.cat)].n++);
  route.track.forEach((p, i) => {
    if (!p.sv) return;
    p.svSites = p.sv.map((id) => byId[id]).filter(Boolean);
    const prev = route.track[i - 1];
    if (!prev?.sv) return;
    for (const g of new Set(p.svSites.map((x) => sivaGroup(x.cat)))) {
      if (prev.svSites.some((x) => sivaGroup(x.cat) === g)) stats[g].m += p.d - prev.d;
    }
  });
  route.sivaStats = stats;
}

async function loadSiva(route) {
  if (!route.siva?.file) return null;
  if (!sivaCache[route.id]) {
    sivaCache[route.id] = fetch(`data/${route.siva.file}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return sivaCache[route.id];
}

/** Testo breve: "2 valanghe documentate (2,3 km) · 1 zona pericolosa (17 m)". */
function sivaSummary(route) {
  const st = route.sivaStats;
  if (!st) return "";
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${Math.round(m)} m`);
  const part = (g, one, many) => (st[g].n ? `${st[g].n} ${st[g].n > 1 ? many : one} (${km(st[g].m)})` : null);
  return [part("doc", "valanga documentata", "valanghe documentate"), part("zone", "zona pericolosa", "zone pericolose"),
    part("foto", "valanga da fotointerpretazione", "valanghe da fotointerpretazione")].filter(Boolean).join(" · ");
}
const sivaCount = (route) => route.siva?.sites?.length ?? 0;

// ------------------------------------------------------------------ routing (#/gita/data)

// #/esplora/<data>  → mappa + lista
// #/gita/<id>/<data> → radiografia
function readHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const isRoute = (id) => state.data.routes.some((r) => r.id === id);
  let date = null;
  if (parts[0] === "gita" && isRoute(parts[1])) {
    state.view = "detail"; state.routeId = parts[1]; date = parts[2];
  } else if (isRoute(parts[0])) {          // formato precedente #/<id>/<data>
    state.view = "detail"; state.routeId = parts[0]; date = parts[1];
  } else {
    state.view = "explore"; date = parts[1];
  }
  if (date && state.data.windowDays.includes(date)) state.date = date;
}
const hashFor = (view, id = state.routeId) =>
  view === "detail" ? `#/gita/${id}/${state.date}` : `#/esplora/${state.date}`;
function writeHash() {
  const h = hashFor(state.view);
  if (location.hash !== h) history.replaceState(null, "", h);
}

// ------------------------------------------------------------------ form

function initForm() {
  const { windowDays, regionNames, routes } = state.data;
  const area = $("#f-area");
  const provs = [...new Set(routes.map((r) => r.province))];
  area.innerHTML = `<option value="all">Tutto il Piemonte</option>
    <optgroup label="Provincia">${provs.map((p) => `<option value="prov:${p}">${p === "TO" ? "Torino" : p === "CN" ? "Cuneo" : p}</option>`).join("")}</optgroup>
    <optgroup label="Micro-regione AINEVA">${Object.entries(regionNames).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, n]) => `<option value="reg:${id}">${esc(n)} (${id.slice(6)})</option>`).join("")}</optgroup>`;
  $("#f-date").innerHTML = windowDays.map((d) => `<option value="${d}">${fmtDay(d, { weekday: "long", day: "numeric", month: "long" })}</option>`).join("");
  $("#f-group").innerHTML = Object.entries(GROUP_FACTORS).map(([k, g]) => `<option value="${k}">${g.label}</option>`).join("");
  $("#f-date").value = state.date;
  $("#f-group").value = state.filters.group;
  $("#search").addEventListener("input", onForm);
  $("#search").addEventListener("change", onForm);
}

let prevArea = "all";
function onForm() {
  const f = new FormData($("#search"));
  state.filters = {
    area: f.get("area"), gain: +f.get("gain") || 99999, length: +f.get("length") || 999,
    diff: f.get("diff"), group: f.get("group"),
  };
  if (f.get("date") !== state.date) state.date = f.get("date");
  if (f.get("area") !== prevArea) { state.fitArea = true; prevArea = f.get("area"); }
  render();
}

// ------------------------------------------------------------------ classifica

function matchesArea(r, area) {
  if (area === "all") return true;
  const [k, v] = area.split(":");
  return k === "prov" ? r.province === v : r.region === v;
}

function rank() {
  const { routes, bulletins } = state.data;
  const f = state.filters;
  const inArea = routes.filter((r) => matchesArea(r, f.area));
  const ok = [], excluded = [];
  for (const r of inArea) {
    const why = [];
    if (r.stats.gain_m > f.gain) why.push(`dislivello ${r.stats.gain_m} m`);
    if (r.stats.length_m / 1000 > f.length) why.push(`salita ${(r.stats.length_m / 1000).toFixed(1)} km`);
    if (DIFF_ORDER.indexOf(r.difficulty) > DIFF_ORDER.indexOf(f.diff)) why.push(`difficoltà ${r.difficulty}`);
    if (why.length) excluded.push({ r, why });
    else ok.push(analyzeRoute(r, bulletins, state.date, { group: f.group }));
  }
  ok.sort((a, b) => b.score - a.score);
  const inView = (r) => {
    const b = state.mapBounds, p = r.track[0];
    return !b || (p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e);
  };
  const followMap = state.view === "explore" && state.searchOnMove && state.mapBounds;
  const visible = followMap ? ok.filter((a) => inView(a.route)) : ok;
  return { ok, visible, excluded, inArea, hidden: ok.length - visible.length };
}

function dangerBadge(lv) {
  if (!lv) return `<span class="badge">Nessun bollettino</span>`;
  const d = DANGER[lv];
  return `<span class="badge danger-badge" style="background:${d.color};color:${d.ink}">Pericolo ${d.label}</span>`;
}
function verdictBadge(v) {
  const x = VERDICT[v];
  return `<span class="badge verdict-${v}"><span class="icon-dot"><span>${x.icon}</span></span>${x.label}</span>`;
}

function sivaBadge(route) {
  const n = sivaCount(route);
  return n ? `<span class="badge badge-siva" title="Siti valanghivi storici sulla traccia (Arpa Piemonte – SIVA). Solo informativo.">Storico: ${n} ${n > 1 ? "siti" : "sito"}</span>` : "";
}

function renderResults() {
  const all = rank();
  const { ok, visible, excluded, inArea, hidden } = all;
  $("#results-day").textContent = fmtDay(state.date, { weekday: "long", day: "numeric", month: "long" });
  const list = $("#results");
  list.innerHTML = visible.length ? visible.map((a, i) => `
    <li><button class="card" data-id="${a.route.id}" aria-current="${state.view === "detail" && a.route.id === state.routeId}">
      <span class="card-rank">${i + 1}</span>
      <span>
        <span class="card-name">${esc(a.route.name)}</span>
        <span class="card-meta">${esc(a.route.valley)} · D+ ${a.route.stats.gain_m} m · ${a.route.difficulty}</span>
        <span class="card-badges">${verdictBadge(a.verdict)}${dangerBadge(a.maxDanger)}${sivaBadge(a.route)}</span>
      </span>
      <span class="card-score" title="Punteggio 0–100: sicurezza 60%, neve 25%, meteo 15%"><b>${a.score}</b><span class="card-meta">/100</span></span>
    </button></li>`).join("")
    : `<li class="muted">${ok.length ? "Nessuna gita nell'area visibile della mappa." : inArea.length ? "Nessuna gita rispetta i filtri." : "Nessuna gita nel catalogo del prototipo per quest'area."}</li>`;
  list.querySelectorAll(".card").forEach((b) => {
    b.addEventListener("click", () => { location.hash = hashFor("detail", b.dataset.id); });
    b.addEventListener("mouseenter", () => exploreApi?.highlight(b.dataset.id));
    b.addEventListener("mouseleave", () => exploreApi?.highlight(null));
  });
  $("#results-info").innerHTML = state.view === "explore" ? `
    <label class="check"><input type="checkbox" id="f-follow" ${state.searchOnMove ? "checked" : ""}>
      Aggiorna la lista quando sposto la mappa</label>
    ${hidden ? `<span class="muted">${hidden} ${hidden > 1 ? "gite" : "gita"} fuori dalla mappa ·
      <button type="button" class="linkbtn" id="show-all">mostra tutte</button></span>` : ""}` : "";
  $("#f-follow")?.addEventListener("change", (e) => { state.searchOnMove = e.target.checked; renderResults(); });
  $("#show-all")?.addEventListener("click", () => { state.fitArea = true; render(); });
  $("#excluded").innerHTML = excluded.length
    ? `<ul class="excluded">${excluded.map((e) => `<li>Esclusa: ${esc(e.r.name)} (${e.why.join(", ")})</li>`).join("")}</ul>` : "";
  return all;
}

// ------------------------------------------------------------------ esplora (mappa + lista)

function areaBounds(all) {
  const { area } = state.filters;
  const pts = (all.ok.length ? all.ok.map((a) => a.route) : all.inArea).map((r) => [r.track[0].lat, r.track[0].lon]);
  if (area.startsWith("reg:")) {
    const f = state.data.regions.features.find((x) => x.properties.id === area.slice(4));
    if (f) return L.geoJSON(f).getBounds();
  }
  if (pts.length) return L.latLngBounds(pts).pad(pts.length > 1 ? 0.3 : 0.05);
  return L.geoJSON(state.data.regions).getBounds();
}

function renderExploreView(all) {
  const root = $("#detail");
  root.innerHTML = `
    <section class="panel explore">
      <div class="panel-head">
        <h2 class="panel-title">Gite del ${fmtDay(state.date, { weekday: "long", day: "numeric", month: "long" })}</h2>
        <span class="muted">Clicca un segnaposto per i dettagli</span>
      </div>
      <div id="explore-map"></div>
      ${exploreLegend()}
    </section>`;
  exploreApi = renderExplore($("#explore-map"), {
    analyses: all.ok, excluded: all.excluded, date: state.date,
    bulletins: state.data.bulletins, regions: state.data.regions, regionNames: state.data.regionNames,
    fitTo: state.fitArea ? areaBounds(all) : null,
    onHover: (id) => document.querySelectorAll(".card").forEach((c) => c.classList.toggle("hover", c.dataset.id === id)),
    onMove: (b) => {
      state.mapBounds = { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() };
      renderResults();
    },
  });
  state.fitArea = false;
}

function destroyExplore() {
  exploreApi?.destroy();
  exploreApi = null;
}

// ------------------------------------------------------------------ radiografia

function bandsText(a) {
  const bands = dangerBands(a.bull, a.route.stats.start_ele, a.route.stats.summit_ele).filter((b) => b.level);
  if (!bands.length) return "–";
  if (bands.length === 1) return "su tutta la gita";
  return bands.map((b) => `${b.level} ${b.lower === a.route.stats.start_ele ? `sotto ${b.upper}` : `sopra ${b.lower}`} m`).join(" · ");
}

function renderDetail(a) {
  const { route } = a;
  const { windowDays, allDays, regionNames, bulletins } = state.data;
  const t = a.ctx.today;
  const regionName = regionNames[route.region] ?? route.region;
  const html = `
  <section class="panel hero">
    <a class="back" href="${hashFor("explore")}">← Torna alla mappa</a>
    <div class="hero-head">
      <div>
        <h1>${esc(route.name)}</h1>
        <div class="hero-sub">${esc(route.valley)} (${route.province}) · micro-regione <b>${esc(regionName)}</b> ·
          D+ ${route.stats.gain_m} m · ${(route.stats.length_m / 1000).toFixed(1)} km di salita · ${route.difficulty} ·
          <a href="${route.gulliver_url}" target="_blank" rel="noopener">scheda Gulliver ↗</a></div>
      </div>
      <div>${verdictBadge(a.verdict)}</div>
    </div>
    <div class="days" role="group" aria-label="Giorno">
      ${windowDays.map((d) => {
        const lv = bulletinFor(bulletins, d, route.region)?.max_level ?? 0;
        return `<button class="day" data-day="${d}" aria-pressed="${d === state.date}">
          <span>${fmtDay(d, { weekday: "short", day: "numeric" })}</span>
          <span class="day-chip" style="background:${lv ? DANGER[lv].color : "transparent"};color:${lv ? DANGER[lv].ink : "inherit"}">${lv || "–"}</span>
        </button>`;
      }).join("")}
    </div>
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Pericolo valanghe</div>
        <div class="kpi-value">${a.maxDanger ? DANGER[a.maxDanger].label : "–"}</div>
        <div class="kpi-note">${bandsText(a)}${a.bull?.tendency ? ` · tendenza ${tendencyIt(a.bull.tendency)}` : ""}</div></div>
      <div class="kpi"><div class="kpi-label">Rischio sulla traccia</div>
        <div class="kpi-value">${a.exposure ? `${Math.round(a.exposure)} m oltre soglia` : "Entro soglia"}</div>
        <div class="kpi-note">rischio max ${a.riskMax.toFixed(2)} · pendenza max ${route.stats.max_slope}°</div></div>
      <div class="kpi"><div class="kpi-label">Neve stimata</div>
        <div class="kpi-value" style="font-size:15px">${esc(a.snow.top)}</div>
        <div class="kpi-note">in basso: ${esc(a.snow.bottom)}</div></div>
      <div class="kpi"><div class="kpi-label">Meteo del giorno (vetta)</div>
        <div class="kpi-value" style="font-size:15px">${t.wind_day} km/h ${t.wind_dir_day ?? ""} · ${t.cloud_day}% nubi</div>
        <div class="kpi-note">zero termico ${t.freezing_min}–${t.freezing_max} m · neve ${t.snowfall_cm} cm</div></div>
    </div>
    <ul class="reasons">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}
      ${a.weather.notes.map((r) => `<li>${esc(r[0].toUpperCase() + r.slice(1))}</li>`).join("")}</ul>
    ${sivaCount(route) ? `<div class="siva-note"><b>Storico valanghe:</b> la traccia attraversa ${esc(sivaSummary(route))}.
      Solo informativo: non cambia il giudizio. <a href="#siva-panel" class="linkbtn" data-scroll="siva-panel">Dettagli</a></div>` : ""}
    <div class="evolution"><b>Evoluzione:</b> ${esc(evolutionText(route, bulletins, state.date))}</div>
  </section>

  <section class="panel">
    <h2 class="panel-title">Bollettino sul profilo della gita</h2>
    <p class="panel-sub">Traccia ${route.stats.track_source === "gpx" ? "GPX da Gulliver" : "stimata dai waypoint sul DEM"} ·
      quote, pendenze ed esposizioni da Copernicus DEM 30 m. Passa il mouse sul profilo.</p>
    <div id="profile"></div>
    ${profileLegend()}
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2 class="panel-title">Mappa</h2>
      <div class="seg" role="group" aria-label="Tipo di mappa">
        <button type="button" data-mode="2d" aria-pressed="${mapPrefs.mode === "2d"}">2D</button>
        <button type="button" data-mode="3d" aria-pressed="${mapPrefs.mode === "3d"}" ${webglOk ? "" : "disabled title=\"WebGL non disponibile\""}>3D</button>
      </div>
    </div>
    <div id="map-tools" class="map-tools"></div>
    <div id="map" class="map-${mapPrefs.mode}"></div>
    <div id="map-legend"></div>
  </section>

  <section class="panel" id="siva-panel">${sivaPanel(route)}</section>

  <div class="grid-2">
    <section class="panel">
      <h2 class="panel-title">Bollettini e meteo dei giorni prima</h2>
      <p class="panel-sub">Dal ${fmtDay(allDays[0], { day: "numeric", month: "long" })}. Clicca un giorno della finestra per selezionarlo.</p>
      <div id="meteo" class="small-multiples"></div>
    </section>
    <section class="panel">${bulletinPanel(a, regionName)}</section>
  </div>

  <section class="panel">${reportsPanel(route)}</section>

  <p class="footer-sources">Fonti: ${Object.values(state.data.meta.sources).map(esc).join(" · ")}.
    Mappa © OpenStreetMap, OpenTopoMap (CC-BY-SA).</p>`;

  const root = $("#detail");
  root.innerHTML = html;
  root.querySelectorAll(".day").forEach((b) => b.addEventListener("click", () => selectDay(b.dataset.day)));
  // l'hash è usato dal routing: il link "Dettagli" scorre senza cambiarlo
  root.querySelectorAll("[data-scroll]").forEach((l) => l.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById(l.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  profileApi = renderProfile($("#profile"), a, { onHover: (p) => mapApi?.mark(p) });
  renderMeteo($("#meteo"), route, bulletins, allDays, state.date, {
    selectable: windowDays, onSelect: selectDay,
  });
  root.querySelectorAll(".seg [data-mode]").forEach((b) => b.addEventListener("click", () => {
    if (mapPrefs.mode === b.dataset.mode) return;
    mapPrefs.mode = b.dataset.mode; saveMapPrefs();
    root.querySelectorAll(".seg [data-mode]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    renderMapPanel(a);
  }));
  renderMapPanel(a);
}

// ------------------------------------------------------------------ pannello mappa (2D / 3D)

function destroyMap() {
  mapApi?.destroy();
  mapApi = null;
  if (map) { map.remove(); map = null; }
  const el = $("#map");
  if (el) { el.innerHTML = ""; el.className = ""; el.removeAttribute("style"); }
}

const sivaToggle = () => `<label class="check"><input type="checkbox" id="m-siva" ${mapPrefs.siva ? "checked" : ""}>
  Valanghe storiche (SIVA)</label>`;

async function renderMapPanel(a) {
  destroyMap();
  const tools = $("#map-tools"), legend = $("#map-legend"), el = $("#map");
  const mode = mapPrefs.mode;
  const siva = await loadSiva(a.route);
  // l'utente può aver cambiato gita o modalità durante il caricamento
  if (mapPrefs.mode !== mode || state.routeId !== a.route.id || $("#map") !== el) return;
  const legendHtml = (extra = "") => extra + (siva && mapPrefs.siva ? sivaLegend() : "");
  if (mapPrefs.mode === "3d" && webglOk && window.maplibregl) {
    el.className = "map-3d";
    tools.innerHTML = `
      <label>Sovrapposizione
        <select id="m3d-overlay">
          <option value="bulletin">Bollettino sul terreno</option>
          <option value="slope">Classi di pendenza</option>
          <option value="none">Nessuna</option>
        </select></label>
      <label>Base
        <select id="m3d-base"><option value="topo">Topografica</option><option value="sat">Satellite</option></select></label>
      ${siva ? sivaToggle() : ""}
      <button type="button" id="m3d-fly" class="btn">▶ Volo lungo la traccia</button>
      <span class="muted">Trascina per ruotare (tasto destro o Ctrl) · rotella disattivata: usa + / −</span>`;
    $("#m3d-overlay").value = mapPrefs.overlay;
    $("#m3d-base").value = mapPrefs.base;
    legend.innerHTML = legendHtml(legend3D(mapPrefs.overlay));
    let grid = grids[a.route.id];
    if (!grid) {
      el.innerHTML = `<div class="empty">Carico il terreno…</div>`;
      try {
        grid = grids[a.route.id] = decodeGrid(await fetch(`data/grid_${a.route.id}.json`).then((r) => r.json()));
      } catch (err) {
        el.innerHTML = `<div class="empty">Griglia 3D non disponibile (${esc(err.message)}). Esegui <code>make data</code>.</div>`;
        return;
      }
      // l'utente può aver cambiato gita o modalità durante il caricamento
      if (mapPrefs.mode !== "3d" || state.routeId !== a.route.id || !$("#map")) return;
      el.innerHTML = "";
    }
    mapApi = render3D(el, a, grid, {
      overlay: mapPrefs.overlay, base: mapPrefs.base, siva, showSiva: mapPrefs.siva,
      onHover: (p) => profileApi?.mark(p),
      onFlight: (on) => { const b = $("#m3d-fly"); if (b) b.textContent = on ? "■ Ferma il volo" : "▶ Volo lungo la traccia"; },
    });
    $("#m3d-overlay").addEventListener("change", (e) => {
      mapPrefs.overlay = e.target.value; saveMapPrefs();
      mapApi.setOverlay(mapPrefs.overlay);
      legend.innerHTML = legendHtml(legend3D(mapPrefs.overlay));
    });
    $("#m3d-base").addEventListener("change", (e) => { mapPrefs.base = e.target.value; saveMapPrefs(); mapApi.setBase(mapPrefs.base); });
    $("#m3d-fly").addEventListener("click", () => mapApi.fly());
  } else {
    el.className = "map-2d";
    tools.innerHTML = `${siva ? sivaToggle() : ""}<span class="muted">Micro-regioni colorate per grado di pericolo del giorno.</span>`;
    legend.innerHTML = legendHtml();
    renderMap(a, siva);
  }
  $("#m-siva")?.addEventListener("change", (e) => {
    mapPrefs.siva = e.target.checked; saveMapPrefs();
    mapApi?.setSiva(mapPrefs.siva);
    legend.innerHTML = legendHtml(mapPrefs.mode === "3d" ? legend3D(mapPrefs.overlay) : "");
  });
}

function tendencyIt(t) {
  return { increasing: "in aumento ↗", decreasing: "in calo ↘", steady: "stabile →" }[t] ?? t;
}

function bulletinPanel(a, regionName) {
  const b = a.bull;
  if (!b) return `<h2 class="panel-title">Bollettino</h2><p class="muted">Nessun bollettino per questo giorno.</p>`;
  const elev = (p) => p.lower != null && p.upper != null ? `${p.lower}–${p.upper} m`
    : p.lower != null ? `sopra ${p.lower} m` : p.upper != null ? `sotto ${p.upper} m` : "tutte le quote";
  const period = (p) => ({ earlier: " · mattino", later: " · pomeriggio" }[p.period] ?? "");
  return `
    <h2 class="panel-title">Bollettino AINEVA · ${esc(regionName)}</h2>
    <p class="panel-sub">Valido per ${fmtDay(a.date, { weekday: "long", day: "numeric", month: "long" })} ·
      pubblicato ${new Date(b.published).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
      ${b.unscheduled ? " · aggiornamento" : ""}</p>
    <div class="problems">
      ${b.problems.map((p) => `<div class="problem">${aspectRose(p.aspects)}
        <div><div class="problem-name">${esc(PROBLEMS[p.type] ?? p.type)}</div>
        <div class="problem-meta">${elev(p)}${period(p)}</div>
        <div class="problem-meta">${p.aspects.length === 8 ? "tutte le esposizioni" : p.aspects.join(" ")}</div></div></div>`).join("")}
    </div>
    <div class="bull-text">
      <h3>In evidenza</h3><p>${rich(b.highlights)}</p>
      ${b.tendency_text ? `<h3>Tendenza</h3><p>${esc(b.tendency_text)}</p>` : ""}
      <details><summary>Testo completo: attività valanghiva e manto nevoso</summary>
        <h3>Attività valanghiva</h3><p>${rich(b.activity)}</p>
        <h3>Manto nevoso</h3><p>${rich(b.snowpack)}</p>
      </details>
    </div>`;
}

function sivaPanel(route) {
  const sites = route.siva?.sites ?? [], events = route.siva?.events ?? [];
  const c = route.siva?.counts;
  const head = `<h2 class="panel-title">Valanghe storiche sulla traccia</h2>
    <p class="panel-sub">Catasto valanghe di Arpa Piemonte (SIVA). Mostra dove sono già scese valanghe
      o dove il terreno è pericoloso. Solo informativo: non entra nel punteggio.</p>`;
  if (!route.siva) return `${head}<p class="muted">Dati SIVA non disponibili. Esegui <code>make data</code>.</p>`;
  const km = (d) => (d / 1000).toFixed(1).replace(".", ",");
  const list = sites.length ? `<ul class="siva-list">${sites.map((x) => `<li>
      <i class="siva-chip" style="background:${SIVA[x.cat].color}"></i>
      <div><b>${esc(x.name ?? SIVA[x.cat].label)}</b> <span class="muted">${x.name ? ` · ${SIVA[x.cat].short}` : ""}${x.comune ? ` · ${esc(x.comune)}` : ""}</span>
        <div class="report-snow">dal km ${km(x.from_d)} · quota ${x.ele[0]}–${x.ele[1]} m · ${x.track_m} m di traccia${x.method ? ` · rilievo: ${esc(x.method.toLowerCase())}` : ""}
        ${x.link ? ` · <a href="${esc(x.link)}" target="_blank" rel="noopener">scheda Arpa ↗</a>` : ""}</div></div></li>`).join("")}</ul>`
    : `<p class="muted">Nessun sito valanghivo censito entro 30 m dalla traccia.</p>`;
  const ev = events.length ? `<h3 class="siva-h3">Eventi storici vicini</h3><ul class="siva-list">${events.map((x) => `<li>
      <i class="siva-chip siva-chip-dot"></i><div><b>${esc(x.name ?? "Evento")}</b> <span class="muted">· ${esc(x.date ?? "data ignota")} · a ${x.dist_m} m dalla traccia</span>
      ${x.link ? ` · <a href="${esc(x.link)}" target="_blank" rel="noopener">scheda ↗</a>` : ""}</div></li>`).join("")}</ul>` : "";
  const area = c ? `<p class="panel-sub">Nell'area della mappa: ${c.doc + c.astv} valanghe documentate,
    ${c.zone} zone pericolose, ${c.foto} valanghe da fotointerpretazione. Clicca un'area sulla mappa per la scheda.</p>` : "";
  return `${head}${list}${ev}${area}
    <p class="footer-sources">Dati © Arpa Piemonte – SIVA, licenza CC BY 4.0. Il catasto non è completo:
      l'assenza di un sito non indica che il pendio sia sicuro.</p>`;
}

function reportsPanel(route) {
  const before = route.reports.filter((r) => r.date <= state.date);
  const days = (d) => Math.round((new Date(state.date) - new Date(d)) / 864e5);
  const age = (d) => { const n = days(d); return n === 0 ? "oggi" : n === 1 ? "ieri" : `${n} giorni prima`; };
  return `
    <h2 class="panel-title">Ultime relazioni Gulliver</h2>
    <p class="panel-sub">Relazioni pubblicate fino al giorno scelto, sulla gita e sulle gite vicine.</p>
    ${before.length ? `<ul class="reports">${before.map((r) => {
      const alert = /valang/i.test(r.observations ?? "");
      const stale = days(r.date) > 14;
      return `<li class="report">
        <div class="report-head"><b>${fmtDay(r.date, { day: "numeric", month: "short", year: "numeric" })}</b>
          <span class="report-age">${age(r.date)}</span>
          <span class="report-tag">${r.relation === "same" ? "stessa gita" : `vicina: ${esc(r.route_name)}`}</span>
          ${alert ? `<span class="report-tag report-alert">⚠ ${esc(r.observations)}</span>` : ""}
          ${stale ? `<span class="report-tag">poco recente</span>` : ""}
          ${r.rating ? `<span class="report-age">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>` : ""}</div>
        ${r.snow_top || r.snow_bottom ? `<div class="report-snow">Neve: in alto ${esc(r.snow_top ?? "–")} · in basso ${esc(r.snow_bottom ?? "–")}${r.snow_line_m ? ` · quota neve ${r.snow_line_m} m` : ""}</div>` : ""}
        <div class="report-text">${esc(r.summary)}</div>
        <div class="report-snow">di ${esc(r.user)} · <a href="${r.url}" target="_blank" rel="noopener">leggi su Gulliver ↗</a></div>
      </li>`;
    }).join("")}</ul>` : `<p class="muted">Nessuna relazione prima di questo giorno.</p>`}`;
}

// ------------------------------------------------------------------ mappa

let hoverMarker = null;

const SIVA_STYLE = {
  doc: { weight: 2, dashArray: null, fill: 0.22 },
  astv: { weight: 2, dashArray: null, fill: 0.22 },
  zone: { weight: 1.6, dashArray: "6 4", fill: 0.16 },
  foto: { weight: 1.4, dashArray: "2 4", fill: 0.12 },
};

function renderMap(a, siva) {
  if (map) { map.remove(); map = null; }
  let sivaLayer = null;
  mapApi = {
    kind: "2d", mark: (p) => mapMark(p), destroy() {},
    setSiva(on) { if (sivaLayer) { if (on) sivaLayer.addTo(map); else sivaLayer.remove(); } },
  };
  map = L.map("map", { scrollWheelZoom: false });
  // la vista va impostata prima di aggiungere i layer vettoriali
  map.fitBounds(L.latLngBounds(a.points.map((p) => [p.lat, p.lon])).pad(0.35));
  // ordine: micro-regioni (400) < siti SIVA (410) < traccia (420)
  map.createPane("siva").style.zIndex = 410;
  map.createPane("track").style.zIndex = 420;
  L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17, attribution: "© OpenStreetMap, SRTM · OpenTopoMap (CC-BY-SA)",
  }).addTo(map);

  const { bulletins, regions, regionNames } = state.data;
  L.geoJSON(regions, {
    style: (f) => {
      const lv = bulletinFor(bulletins, state.date, f.properties.id)?.max_level ?? 0;
      const own = f.properties.id === a.route.region;
      return { color: own ? "#0b2239" : "#5b6b7c", weight: own ? 2.5 : 1, fillColor: lv ? DANGER[lv].color : "#999", fillOpacity: own ? 0.3 : 0.18 };
    },
    onEachFeature: (f, layer) => {
      const lv = bulletinFor(bulletins, state.date, f.properties.id)?.max_level ?? 0;
      layer.bindTooltip(`${esc(regionNames[f.properties.id])} · pericolo ${lv || "–"}`, { sticky: true });
    },
  }).addTo(map);

  if (siva) {
    sivaLayer = L.geoJSON(siva, {
      pane: "siva",
      style: (f) => {
        const p = f.properties, st = SIVA_STYLE[p.cat];
        return { color: SIVA[p.cat].color, weight: st.weight, dashArray: st.dashArray,
          fillColor: SIVA[p.cat].color, fillOpacity: p.track_m ? st.fill * 1.6 : st.fill, opacity: p.track_m ? 1 : 0.75 };
      },
      pointToLayer: (f, ll) => L.circleMarker(ll, { pane: "siva", radius: 6, color: "#fff", weight: 2, fillColor: SIVA.event.color, fillOpacity: 1 }),
      onEachFeature: (f, layer) => {
        layer.bindTooltip(esc(sivaName(f.properties)), { sticky: true });
        layer.bindPopup(sivaPopup(f.properties), { maxWidth: 280 });
      },
    });
    if (mapPrefs.siva) sivaLayer.addTo(map);
  }

  const pts = a.points;
  const colors = { low: "#1f8a4c", mid: "#c98a00", high: "#c62f2f" };
  let s = 0;
  for (let i = 1; i <= pts.length; i++) {
    if (i === pts.length || pts[i].rc !== pts[s].rc) {
      L.polyline(pts.slice(s, Math.min(i + 1, pts.length)).map((p) => [p.lat, p.lon]),
        { pane: "track", color: colors[pts[s].rc], weight: 5, opacity: 0.95 }).addTo(map);
      s = i;
    }
  }
  // linea invisibile larga per l'hover sulla traccia
  const hit = L.polyline(pts.map((p) => [p.lat, p.lon]), { pane: "track", weight: 18, opacity: 0 }).addTo(map);
  hit.on("mousemove", (e) => {
    let best = pts[0], bd = Infinity;
    for (const p of pts) {
      const d = (p.lat - e.latlng.lat) ** 2 + ((p.lon - e.latlng.lng) * 0.7) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    mapMark(best);
    profileApi?.mark(best);
    showTip(pointTip(best), e.originalEvent.clientX, e.originalEvent.clientY);
  });
  hit.on("mouseout", () => { mapMark(null); profileApi?.mark(null); hideTip(); });

  const start = pts[0], top = pts[pts.length - 1];
  L.circleMarker([start.lat, start.lon], { pane: "track", radius: 6, color: "#0b2239", fillColor: "#fff", fillOpacity: 1, weight: 2 })
    .bindTooltip(`Partenza · ${esc(a.route.start_name)} ${Math.round(start.ele)} m`).addTo(map);
  L.circleMarker([top.lat, top.lon], { pane: "track", radius: 7, color: "#0b2239", fillColor: "#0b2239", fillOpacity: 1, weight: 2 })
    .bindTooltip(`Vetta · ${esc(a.route.summit_name)} ${Math.round(top.ele)} m`).addTo(map);
  hoverMarker = L.circleMarker([start.lat, start.lon], { pane: "track", radius: 7, color: "#0b2239", weight: 2, fillColor: "#00b4d8", fillOpacity: 1 });
}

function mapMark(p) {
  if (!map || !hoverMarker) return;
  if (!p) { hoverMarker.remove(); return; }
  hoverMarker.setLatLng([p.lat, p.lon]).addTo(map);
}

// ------------------------------------------------------------------ ciclo di render

function selectDay(d) {
  state.date = d;
  $("#f-date").value = d;
  render();
}

function render() {
  document.body.classList.toggle("view-explore", state.view === "explore");
  document.body.classList.toggle("view-detail", state.view === "detail");
  document.body.dataset.pane = state.mobilePane;
  const all = renderResults();
  if (state.view === "explore") {
    destroyMap();
    destroyExplore();
    renderExploreView(all);
  } else {
    destroyExplore();
    if (!state.routeId || !state.data.routes.some((r) => r.id === state.routeId)) state.routeId = all.ok[0]?.route.id ?? state.data.routes[0].id;
    const route = state.data.routes.find((r) => r.id === state.routeId);
    renderDetail(analyzeRoute(route, state.data.bulletins, state.date, { group: state.filters.group }));
  }
  writeHash();
}

async function main() {
  try {
    state.data = await load();
  } catch (err) {
    $("#detail").innerHTML = `<div class="panel">Impossibile caricare i dati (${esc(err.message)}). Hai eseguito <code>make data</code>?</div>`;
    return;
  }
  const { meta, windowDays } = state.data;
  $("#window-label").textContent = `${fmtDay(meta.window.start, { day: "numeric", month: "short" })} – ${fmtDay(meta.window.end, { day: "numeric", month: "short", year: "numeric" })}`;
  state.date = windowDays[0];
  readHash();
  initForm();
  render();
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 200); });
  window.addEventListener("hashchange", () => {
    const prev = state.view;
    readHash();
    $("#f-date").value = state.date;
    render();
    if (prev !== state.view) window.scrollTo({ top: 0 });
  });
  // commutatore Lista | Mappa su mobile
  document.querySelectorAll("#pane-toggle [data-pane]").forEach((b) => b.addEventListener("click", () => {
    state.mobilePane = b.dataset.pane;
    document.body.dataset.pane = state.mobilePane;
    document.querySelectorAll("#pane-toggle [data-pane]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    exploreApi?.invalidate();
  }));
}

main();
