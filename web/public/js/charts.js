// Zefiro – grafici SVG scritti a mano (nessuna libreria).
import { DANGER, PROBLEMS, SECTORS, dangerBands, fmtDay, bulletinFor } from "./engine.js";

const NS = "http://www.w3.org/2000/svg";
const tip = () => document.getElementById("tooltip");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}
export const hideTip = () => { tip().hidden = true; };

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

const niceStep = (span, target) => {
  const raw = span / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
};

const RISK = {
  low: { color: "var(--good)", label: "Rischio basso" },
  mid: { color: "var(--warn)", label: "Rischio al limite" },
  high: { color: "var(--crit)", label: "Oltre soglia" },
};

const slopeColor = (s) =>
  s >= 45 ? "var(--slope-45)" : s >= 40 ? "var(--slope-40)" : s >= 35 ? "var(--slope-35)"
    : s >= 30 ? "var(--slope-30)" : "var(--slope-0)";

// Siti valanghivi storici (Arpa Piemonte – SIVA). Solo informativi: non cambiano il rischio.
export const SIVA = {
  doc: { label: "Valanga documentata", short: "documentata", color: "#3f51b5", rank: 3 },
  astv: { label: "Valanga d'archivio storico", short: "archivio storico", color: "#3f51b5", rank: 3 },
  zone: { label: "Zona pericolosa", short: "zona pericolosa", color: "#7986cb", rank: 2 },
  foto: { label: "Valanga da fotointerpretazione", short: "fotointerpretazione", color: "#c5cae9", rank: 1 },
  event: { label: "Evento storico", short: "evento storico", color: "#3f51b5", rank: 0 },
};
export const sivaName = (s) => s.name ?? `${SIVA[s.cat].label}${s.comune ? ` · ${s.comune}` : ""}`;
/** Popup di un oggetto SIVA (mappa 2D e 3D). */
export function sivaPopup(p) {
  const line = (t) => `<div class="pop-meta">${t}</div>`;
  return `<div class="pop-name">${esc(p.name ?? SIVA[p.cat].label)}</div>` +
    line(`${SIVA[p.cat].label}${p.comune ? ` · ${esc(p.comune)}` : ""}`) +
    (p.place && p.place !== p.name ? line(`Località: ${esc(p.place)}`) : "") +
    (p.method ? line(`Rilievo: ${esc(p.method.toLowerCase())}`) : "") +
    (p.date ? line(`Data: ${esc(p.date)}`) : "") +
    (p.caught || p.dead ? line(`Travolti: ${esc(p.caught ?? "–")} · morti: ${esc(p.dead ?? "–")}`) : "") +
    (p.track_m ? line(`<b>Sulla traccia:</b> ${p.track_m} m, quota ${p.ele[0]}–${p.ele[1]} m`)
      : p.dist_m != null ? line(`A ${p.dist_m} m dalla traccia`) : line("Non attraversato dalla traccia")) +
    (p.link ? `<a class="pop-link" href="${esc(p.link)}" target="_blank" rel="noopener">Scheda Arpa Piemonte ↗</a>` : "");
}

export function sivaLegend() {
  return `<div class="legend">
    <span>Valanghe storiche (Arpa SIVA):</span>
    <span><i style="background:${SIVA.doc.color}55;border:2px solid ${SIVA.doc.color}"></i>Documentata</span>
    <span><i style="background:${SIVA.zone.color}44;border:2px dashed ${SIVA.zone.color}"></i>Zona pericolosa</span>
    <span><i style="background:${SIVA.foto.color}55;border:2px dotted ${SIVA.foto.color}"></i>Da fotointerpretazione</span>
    <span>· più marcate se la traccia le attraversa · clicca per la scheda</span>
  </div>`;
}

/** Categoria SIVA più rilevante nel punto (o null). */
export const sivaTop = (p) => (p.svSites ?? []).reduce((b, s) => (!b || SIVA[s.cat].rank > SIVA[b.cat].rank ? s : b), null);

const row = (k, v) => `<div class="row"><span>${k}</span><span>${v}</span></div>`;

export function pointTip(p) {
  const probs = p.problems.map((x) => PROBLEMS[x.type] ?? x.type).join(", ") || "nessuno";
  return `<b>${Math.round(p.ele)} m · km ${(p.d / 1000).toFixed(2)}</b>` +
    row("Pendenza", `${p.slope}° (max intorno ${p.slope_max}°)`) +
    row("Esposizione", `${p.aspect} (${p.aspect_deg}°)`) +
    row("Pericolo", p.danger ? DANGER[p.danger].label : "–") +
    row("Problemi attivi qui", probs) +
    (p.lee ? row("Sottovento", "possibili accumuli") : "") +
    (p.svSites?.length ? row("Valanghe storiche", p.svSites.map((s) => `${esc(sivaName(s))} (${SIVA[s.cat].short})`).join("<br>")) : "") +
    row("Rischio (Munter)", `${p.risk.toFixed(2)} · ${RISK[p.rc].label}`);
}

// ------------------------------------------------------------------ profilo

/**
 * Profilo altimetrico con: bande di pericolo per quota, traccia colorata per
 * rischio, tratti oltre soglia, strisce di pendenza / esposizione critica /
 * sottovento. `onHover(point|null)` sincronizza la mappa.
 */
export function renderProfile(container, a, { onHover } = {}) {
  container.innerHTML = "";
  const pts = a.points;
  const W = Math.max(320, container.clientWidth || 800);
  const m = { l: 46, r: 12, t: 10 };
  const plotH = 240, stripH = 12, stripGap = 6;
  const strips = [
    { key: "slope", label: "Pendenza" },
    { key: "crit", label: "Esp. critica" },
    { key: "lee", label: "Sottovento" },
    { key: "siva", label: "Storico" },
  ];
  const stripsTop = m.t + plotH + 26;
  const H = stripsTop + strips.length * (stripH + stripGap) + 4;
  const svg = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `Profilo altimetrico di ${a.route.name} con pericolo valanghe per quota` }, container);

  const maxD = pts[pts.length - 1].d;
  const eles = pts.map((p) => p.ele);
  const yMin = Math.floor((Math.min(...eles) - 60) / 100) * 100;
  const yMax = Math.ceil((Math.max(...eles) + 60) / 100) * 100;
  const pw = W - m.l - m.r;
  const x = (d) => m.l + (d / maxD) * pw;
  const y = (e) => m.t + plotH - ((e - yMin) / (yMax - yMin)) * plotH;

  // bande di pericolo
  for (const b of dangerBands(a.bull, yMin, yMax)) {
    if (!b.level) continue;
    const y0 = y(b.upper), y1 = y(b.lower);
    el("rect", { x: m.l, y: y0, width: pw, height: y1 - y0, fill: DANGER[b.level].color, "fill-opacity": 0.24 }, svg);
    const txt = b.lower > yMin && b.upper < yMax ? `${b.lower}–${b.upper} m`
      : b.lower > yMin ? `sopra ${b.lower} m` : b.upper < yMax ? `sotto ${b.upper} m` : "tutte le quote";
    const t = el("text", { x: m.l + 6, y: y0 + 14, class: "band-label" }, svg);
    t.textContent = `Pericolo ${b.level} · ${txt}`;
  }

  // griglia e assi
  const ys = niceStep(yMax - yMin, 5);
  for (let e = Math.ceil(yMin / ys) * ys; e <= yMax; e += ys) {
    el("line", { x1: m.l, x2: W - m.r, y1: y(e), y2: y(e), class: "gridline" }, svg);
    el("text", { x: m.l - 6, y: y(e) + 4, "text-anchor": "end" }, svg).textContent = e;
  }
  const xs = niceStep(maxD / 1000, 6);
  for (let k = 0; k <= maxD / 1000 + 1e-9; k += xs) {
    el("text", { x: x(k * 1000), y: m.t + plotH + 16, "text-anchor": "middle" }, svg).textContent =
      `${+k.toFixed(1)} km`;
  }
  el("line", { x1: m.l, x2: W - m.r, y1: m.t + plotH, y2: m.t + plotH, class: "axis-line" }, svg);

  // tratti oltre soglia
  for (const s of a.segments) {
    el("rect", { x: x(s.d0) - 2, y: m.t, width: Math.max(4, x(s.d1) - x(s.d0) + 4), height: plotH,
      fill: "var(--crit)", "fill-opacity": 0.1 }, svg);
  }

  // area sotto il profilo
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)},${y(p.ele).toFixed(1)}`).join("");
  el("path", { d: `${line}L${x(maxD)},${m.t + plotH}L${x(0)},${m.t + plotH}Z`, fill: "var(--area)" }, svg);

  // traccia colorata per classe di rischio (un path per tratto omogeneo)
  let start = 0;
  for (let i = 1; i <= pts.length; i++) {
    if (i === pts.length || pts[i].rc !== pts[start].rc) {
      const seg = pts.slice(start, Math.min(i + 1, pts.length));
      el("path", {
        d: seg.map((p, j) => `${j ? "L" : "M"}${x(p.d).toFixed(1)},${y(p.ele).toFixed(1)}`).join(""),
        fill: "none", stroke: RISK[pts[start].rc].color, "stroke-width": 3,
        "stroke-linecap": "round", "stroke-linejoin": "round",
      }, svg);
      start = i;
    }
  }

  // strisce sotto il profilo
  strips.forEach((s, k) => {
    const sy = stripsTop + k * (stripH + stripGap);
    el("text", { x: m.l - 6, y: sy + stripH - 2, "text-anchor": "end", style: "font-size:10px" }, svg).textContent = s.label;
    pts.forEach((p, i) => {
      const d0 = i ? (pts[i - 1].d + p.d) / 2 : 0;
      const d1 = i < pts.length - 1 ? (p.d + pts[i + 1].d) / 2 : maxD;
      let fill;
      if (s.key === "slope") fill = slopeColor(p.slope_max);
      else if (s.key === "crit") fill = p.problems.length ? "var(--crit)" : "var(--slope-0)";
      else if (s.key === "siva") fill = sivaTop(p) ? SIVA[sivaTop(p).cat].color : "var(--slope-0)";
      else fill = p.lee ? "var(--warn)" : "var(--slope-0)";
      el("rect", { x: x(d0), y: sy, width: Math.max(0.6, x(d1) - x(d0) + 0.3), height: stripH, fill }, svg);
    });
  });

  // hover
  const hl = el("line", { y1: m.t, y2: H - 4, class: "hover-line", visibility: "hidden" }, svg);
  const dot = el("circle", { r: 5, fill: "var(--surface)", stroke: "var(--track)", "stroke-width": 2, visibility: "hidden" }, svg);
  const hit = el("rect", { x: m.l, y: 0, width: pw, height: H, fill: "transparent" }, svg);
  const nearest = (evt) => {
    const r = svg.getBoundingClientRect();
    const d = ((evt.clientX - r.left) * (W / r.width) - m.l) / pw * maxD;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].d - d) < Math.abs(pts[best].d - d)) best = i;
    return pts[best];
  };
  hit.addEventListener("pointermove", (evt) => {
    const p = nearest(evt);
    hl.setAttribute("x1", x(p.d)); hl.setAttribute("x2", x(p.d)); hl.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(p.d)); dot.setAttribute("cy", y(p.ele)); dot.setAttribute("visibility", "visible");
    showTip(pointTip(p), evt.clientX, evt.clientY);
    onHover?.(p);
  });
  hit.addEventListener("pointerleave", () => {
    hl.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden");
    hideTip(); onHover?.(null);
  });

  // marcatore esterno (hover dalla mappa)
  return {
    mark(p) {
      if (!p) { hl.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); return; }
      hl.setAttribute("x1", x(p.d)); hl.setAttribute("x2", x(p.d)); hl.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(p.d)); dot.setAttribute("cy", y(p.ele)); dot.setAttribute("visibility", "visible");
    },
  };
}

export function profileLegend() {
  return `<div class="legend">
    <span><i class="line" style="background:var(--good)"></i>Rischio basso (≤ 0,5)</span>
    <span><i class="line" style="background:var(--warn)"></i>Al limite (0,5–1)</span>
    <span><i class="line" style="background:var(--crit)"></i>Oltre soglia (&gt; 1)</span>
    <span><i style="background:var(--slope-30)"></i>30–35°</span>
    <span><i style="background:var(--slope-35)"></i>35–40°</span>
    <span><i style="background:var(--slope-40)"></i>40–45°</span>
    <span><i style="background:var(--slope-45)"></i>&gt; 45°</span>
    <span><i style="background:var(--crit)"></i>Esposizione e quota nel bollettino</span>
    <span><i style="background:var(--warn)"></i>Sottovento al vento recente</span>
    <span>Storico (Arpa SIVA):</span>
    <span><i style="background:${SIVA.doc.color}"></i>Valanga documentata</span>
    <span><i style="background:${SIVA.zone.color}"></i>Zona pericolosa</span>
    <span><i style="background:${SIVA.foto.color}"></i>Da fotointerpretazione</span>
  </div>`;
}

// ------------------------------------------------------------------ meteo + evoluzione

/**
 * Small multiples per giorno (storico + finestra): pericolo, neve fresca,
 * vento in quota, zero termico. Un asse per grafico, x condiviso.
 */
export function renderMeteo(container, route, bulletins, days, selected, { onSelect, selectable = [] } = {}) {
  container.innerHTML = "";
  const W = Math.max(320, container.clientWidth || 600);
  const m = { l: 46, r: 10 };
  const pw = W - m.l - m.r;
  const n = days.length;
  const cw = pw / n;
  const cx = (i) => m.l + cw * (i + 0.5);
  const summit = Object.fromEntries(route.meteo.summit.daily.map((d) => [d.date, d]));
  const start = Object.fromEntries(route.meteo.start.daily.map((d) => [d.date, d]));
  const sel = days.indexOf(selected);

  const panels = [
    { title: "Pericolo valanghe (max nella micro-regione)", h: 26, kind: "danger" },
    { title: `Neve fresca in vetta (cm/giorno) · ${route.stats.summit_ele} m`, h: 70, kind: "snow" },
    { title: "Vento in quota (km/h)", h: 80, kind: "wind" },
    { title: "Zero termico (m)", h: 90, kind: "freeze" },
  ];

  panels.forEach((P, pi) => {
    const t = document.createElement("div");
    t.className = "sm-title";
    t.textContent = P.title;
    container.appendChild(t);
    const last = pi === panels.length - 1;
    const H = P.h + (last ? 18 : 4);
    const svg = el("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": P.title }, container);
    if (sel >= 0) el("rect", { x: m.l + cw * sel, y: 0, width: cw, height: P.h, fill: "var(--surface-2)" }, svg);

    if (P.kind === "danger") {
      days.forEach((d, i) => {
        const b = bulletinFor(bulletins, d, route.region);
        const lv = b?.max_level ?? 0;
        if (!lv) return;
        el("rect", { x: m.l + cw * i + 2, y: 3, width: cw - 4, height: P.h - 6, rx: 4,
          fill: DANGER[lv].color, stroke: "rgba(0,0,0,.15)" }, svg);
        el("text", { x: cx(i), y: P.h / 2 + 4, "text-anchor": "middle",
          style: `fill:${DANGER[lv].ink};font-weight:700` }, svg).textContent = lv;
      });
    } else {
      let series, maxV, minV = 0, refs = [];
      if (P.kind === "snow") {
        series = [{ v: days.map((d) => summit[d]?.snowfall_cm ?? 0), type: "bar", color: "var(--series-1)" }];
        maxV = Math.max(10, ...series[0].v);
      } else if (P.kind === "wind") {
        series = [
          { v: days.map((d) => summit[d]?.wind_max ?? null), type: "line", color: "var(--series-1)", name: "Vento medio max" },
          { v: days.map((d) => summit[d]?.gust_max ?? null), type: "line", color: "var(--series-2)", dash: "4 3", name: "Raffiche max" },
        ];
        maxV = Math.max(...series[1].v.filter((v) => v != null));
        refs = [{ v: 50, label: "50 km/h" }];
      } else {
        series = [
          { v: days.map((d) => summit[d]?.freezing_max ?? null), lo: days.map((d) => summit[d]?.freezing_min ?? null),
            type: "range", color: "var(--series-1)", name: "Zero termico (min–max)" },
        ];
        minV = Math.min(route.stats.start_ele, ...series[0].lo) - 200;
        maxV = Math.max(route.stats.summit_ele, ...series[0].v) + 200;
        refs = [
          { v: route.stats.summit_ele, label: `vetta ${route.stats.summit_ele} m` },
          { v: route.stats.start_ele, label: `partenza ${route.stats.start_ele} m` },
        ];
      }
      const step = niceStep(maxV - minV, 3);
      minV = Math.floor(minV / step) * step;
      maxV = Math.ceil(maxV / step) * step;
      const yv = (v) => 4 + (P.h - 8) * (1 - (v - minV) / (maxV - minV));
      for (let v = minV; v <= maxV; v += step) {
        el("line", { x1: m.l, x2: W - m.r, y1: yv(v), y2: yv(v), class: "gridline" }, svg);
        el("text", { x: m.l - 6, y: yv(v) + 4, "text-anchor": "end" }, svg).textContent = v;
      }
      for (const r of refs) {
        el("line", { x1: m.l, x2: W - m.r, y1: yv(r.v), y2: yv(r.v), stroke: "var(--ink-3)", "stroke-dasharray": "2 3" }, svg);
        el("text", { x: W - m.r - 4, y: yv(r.v) - 4, "text-anchor": "end", style: "font-size:10px" }, svg).textContent = r.label;
      }
      for (const s of series) {
        if (s.type === "bar") {
          s.v.forEach((v, i) => {
            if (!v) return;
            const bw = Math.min(22, cw * 0.6), top = yv(v), base = yv(minV);
            const r = Math.min(4, (base - top) / 2);
            el("path", { d: `M${cx(i) - bw / 2},${base}V${top + r}q0,-${r} ${r},-${r}H${cx(i) + bw / 2 - r}q${r},0 ${r},${r}V${base}Z`,
              fill: s.color }, svg);
            if (v >= 5) el("text", { x: cx(i), y: top - 3, "text-anchor": "middle", style: "fill:var(--ink-2)" }, svg).textContent = Math.round(v);
          });
        } else if (s.type === "range") {
          const up = s.v.map((v, i) => `${i ? "L" : "M"}${cx(i)},${yv(v)}`).join("");
          const dn = s.lo.map((v, i) => `L${cx(i)},${yv(v)}`).reverse().join("");
          el("path", { d: `${up}${dn}Z`, fill: s.color, "fill-opacity": 0.22 }, svg);
          el("path", { d: up, fill: "none", stroke: s.color, "stroke-width": 2 }, svg);
        } else {
          el("path", { d: s.v.map((v, i) => `${i ? "L" : "M"}${cx(i)},${yv(v)}`).join(""), fill: "none",
            stroke: s.color, "stroke-width": 2, "stroke-dasharray": s.dash }, svg);
          s.v.forEach((v, i) => el("circle", { cx: cx(i), cy: yv(v), r: 3, fill: s.color }, svg));
        }
      }
    }
    if (last) {
      days.forEach((d, i) => {
        el("text", { x: cx(i), y: P.h + 14, "text-anchor": "middle",
          style: i === sel ? "fill:var(--ink);font-weight:700" : null }, svg).textContent =
          (i === 0 || d.endsWith("-01") ? fmtDay(d, { day: "numeric", month: "short" }) : String(+d.slice(8)));
      });
    }
    // hover e click per colonna
    days.forEach((d, i) => {
      const hit = el("rect", { x: m.l + cw * i, y: 0, width: cw, height: H, fill: "transparent",
        style: selectable.includes(d) ? "cursor:pointer" : null }, svg);
      hit.addEventListener("pointermove", (evt) => showTip(dayTip(route, bulletins, d, summit[d], start[d]), evt.clientX, evt.clientY));
      hit.addEventListener("pointerleave", hideTip);
      if (selectable.includes(d)) hit.addEventListener("click", () => { hideTip(); onSelect?.(d); });
    });
  });

  const lg = document.createElement("div");
  lg.className = "legend";
  lg.innerHTML = `<span><i class="line" style="background:var(--series-1)"></i>Vento medio max</span>
    <span><i class="line" style="background:repeating-linear-gradient(90deg,var(--series-2) 0 4px,transparent 4px 7px)"></i>Raffiche max</span>
    <span><i style="background:var(--series-1);opacity:.35"></i>Zero termico min–max</span>`;
  container.appendChild(lg);
}

function dayTip(route, bulletins, d, s, st) {
  const b = bulletinFor(bulletins, d, route.region);
  return `<b>${fmtDay(d, { weekday: "long", day: "numeric", month: "long" })}</b>` +
    row("Pericolo", b ? DANGER[b.max_level].label : "–") +
    (s ? row("Neve fresca vetta", `${s.snowfall_cm} cm`) +
      row("Pioggia partenza", `${st?.rain_mm ?? 0} mm`) +
      row("Vento vetta", `${s.wind_max} km/h (raffiche ${s.gust_max})`) +
      row("Direzione (ore 8–16)", s.wind_dir_day ?? "–") +
      row("Zero termico", `${s.freezing_min}–${s.freezing_max} m`) +
      row("Temperatura vetta", `${s.t_min} / ${s.t_max} °C`) +
      row("Nuvolosità (8–16)", `${s.cloud_day}%`) : "");
}

// ------------------------------------------------------------------ rosa esposizioni

export function aspectRose(aspects, size = 64) {
  const c = size / 2, r = c - 4, ri = r * 0.32;
  const paths = SECTORS.map((s, i) => {
    const a0 = ((i * 45 - 22.5 - 90) * Math.PI) / 180, a1 = ((i * 45 + 22.5 - 90) * Math.PI) / 180;
    const p = (a, rr) => `${(c + rr * Math.cos(a)).toFixed(1)},${(c + rr * Math.sin(a)).toFixed(1)}`;
    const on = aspects.includes(s);
    return `<path d="M${p(a0, ri)}L${p(a0, r)}A${r},${r} 0 0 1 ${p(a1, r)}L${p(a1, ri)}A${ri},${ri} 0 0 0 ${p(a0, ri)}Z"
      fill="${on ? "var(--crit)" : "var(--slope-0)"}"><title>${s}${on ? " (critica)" : ""}</title></path>`;
  }).join("");
  return `<svg class="rose" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img"
    aria-label="Esposizioni critiche: ${aspects.join(", ") || "nessuna"}">${paths}
    <text x="${c}" y="9" text-anchor="middle" style="font-size:9px;font-weight:700;fill:var(--ink-2)">N</text></svg>`;
}
