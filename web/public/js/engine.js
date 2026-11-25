// Zefiro – motore di analisi del prototipo.
//
// Incrocia per ogni punto della traccia: bollettino AINEVA (grado per quota,
// problemi valanghivi per quota ed esposizione), pendenza ed esposizione dal DEM,
// meteo dei giorni precedenti. Il rischio puntuale usa una versione semplificata
// del metodo di riduzione di Munter. È uno strumento di studio, NON di sicurezza.

export const SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export const DANGER = {
  1: { label: "1 – Debole", short: "Debole", color: "#CCFF66", ink: "#1b1f0a" },
  2: { label: "2 – Moderato", short: "Moderato", color: "#FFFF00", ink: "#1f1f00" },
  3: { label: "3 – Marcato", short: "Marcato", color: "#FF9900", ink: "#1f1300" },
  4: { label: "4 – Forte", short: "Forte", color: "#FF0000", ink: "#ffffff" },
  5: { label: "5 – Molto forte", short: "Molto forte", color: "#1a1a1a", ink: "#ffffff" },
};

export const PROBLEMS = {
  new_snow: "Neve fresca",
  wind_slab: "Neve ventata",
  persistent_weak_layers: "Strati deboli persistenti",
  wet_snow: "Neve bagnata",
  gliding_snow: "Valanghe di slittamento",
  cornices: "Cornici",
  no_distinct_avalanche_problem: "Nessun problema evidente",
  favourable_situation: "Situazione favorevole",
};

export const GROUP_FACTORS = {
  small_spaced: { rf: 3, label: "Piccolo gruppo (2–4) con distanze di sicurezza" },
  small: { rf: 2, label: "Piccolo gruppo (2–4)" },
  large_spaced: { rf: 2, label: "Gruppo numeroso con distanze di sicurezza" },
  none: { rf: 1, label: "Nessuna misura" },
};

const DANGER_POTENTIAL = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };

// ----------------------------------------------------------------- utilità

export const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const fmtDay = (iso, opts = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("it-IT", { ...opts, timeZone: "UTC" });

const inRange = (ele, lower, upper) =>
  (lower == null || ele >= lower) && (upper == null || ele < upper);

const sectorIndex = (s) => SECTORS.indexOf(s);

/** Esposizioni sottovento a un vento che soffia DA `dir` (settore ±45°). */
export function leeSectors(dir) {
  if (!dir) return [];
  const i = (sectorIndex(dir) + 4) % 8;
  return [SECTORS[(i + 7) % 8], SECTORS[i], SECTORS[(i + 1) % 8]];
}

// ----------------------------------------------------------------- bollettino

export function bulletinFor(bulletins, date, region) {
  return bulletins?.[date]?.[region] ?? null;
}

/** Grado di pericolo a una quota: il peggiore tra mattino/pomeriggio. */
export function dangerAt(bull, ele) {
  if (!bull) return 0;
  let lvl = 0;
  for (const r of bull.ratings) if (inRange(ele, r.lower, r.upper)) lvl = Math.max(lvl, r.level);
  return lvl || bull.max_level;
}

/** Problemi valanghivi attivi a quota ed esposizione date. */
export function problemsAt(bull, ele, aspect) {
  if (!bull) return [];
  return bull.problems.filter(
    (p) => inRange(ele, p.lower, p.upper) && p.aspects.includes(aspect) &&
      p.type !== "no_distinct_avalanche_problem" && p.type !== "favourable_situation",
  );
}

/** Bande di pericolo per quota, unite e senza duplicati am/pm. */
export function dangerBands(bull, minEle, maxEle) {
  if (!bull) return [];
  const cuts = new Set([minEle, maxEle]);
  for (const r of bull.ratings) for (const v of [r.lower, r.upper])
    if (v != null && v > minEle && v < maxEle) cuts.add(v);
  const xs = [...cuts].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const level = dangerAt(bull, (xs[i] + xs[i + 1]) / 2);
    const last = bands[bands.length - 1];
    if (last && last.level === level) last.upper = xs[i + 1];
    else bands.push({ lower: xs[i], upper: xs[i + 1], level });
  }
  return bands;
}

// ----------------------------------------------------------------- meteo

function daily(route, where, date) {
  return route.meteo[where].daily.find((d) => d.date === date);
}

export function meteoContext(route, date) {
  const prev = [1, 2, 3].map((n) => daily(route, "summit", addDays(date, -n))).filter(Boolean);
  const today = daily(route, "summit", date);
  const todayStart = daily(route, "start", date);
  const prevStart = [1, 2, 3].map((n) => daily(route, "start", addDays(date, -n))).filter(Boolean);
  const new72 = prev.reduce((s, d) => s + d.snowfall_cm, 0);
  const windDays = [today, ...prev.slice(0, 2)].filter(Boolean);
  const windMax = Math.max(...windDays.map((d) => d.wind_max));
  // direzione dominante nei giorni più ventosi
  const windiest = [...windDays].sort((a, b) => b.wind_max - a.wind_max)[0];
  const rain = prevStart.reduce((s, d) => s + d.rain_mm, 0) + (todayStart?.rain_mm ?? 0);
  const summitEle = route.stats.summit_ele;
  const warmTop = prev.some((d) => d.freezing_max > summitEle - 300);
  const newStart72 = prevStart.reduce((s, d) => s + d.snowfall_cm, 0);
  return {
    today, todayStart, new72: Math.round(new72), newStart72: Math.round(newStart72),
    windMax, windDir: windiest?.wind_dir_day,
    lee: windMax >= 30 ? leeSectors(windiest?.wind_dir_day) : [], rain, warmTop,
    warm: warmTop || rain > 1,
  };
}

function snowQuality(ctx) {
  // Stima in due fasce, come i campi delle relazioni Gulliver.
  let top, topScore;
  if (ctx.new72 >= 10 && ctx.windMax < 40) { top = "Polvere"; topScore = 90; }
  else if (ctx.new72 >= 10) { top = "Polvere ventata, accumuli"; topScore = 60; }
  else if (ctx.windMax >= 50) { top = "Crosta da vento / sastrugi"; topScore = 30; }
  else if (ctx.warmTop) { top = "Crosta da rigelo / trasformata"; topScore = 45; }
  else { top = "Neve assestata, poca neve fresca"; topScore = 55; }

  let bottom, bottomScore;
  if (ctx.rain > 2) { bottom = "Bagnata, crosta dopo il rigelo"; bottomScore = 25; }
  else if (ctx.newStart72 >= 5) { bottom = "Neve fresca"; bottomScore = 75; }
  else { bottom = "Trasformata / crosta da rigelo"; bottomScore = 45; }

  const notes = [`${ctx.new72} cm di neve fresca in vetta negli ultimi 3 giorni`];
  if (ctx.windMax >= 30) notes.push(`vento fino a ${ctx.windMax} km/h da ${ctx.windDir}`);
  if (ctx.rain > 0.5) notes.push(`${ctx.rain.toFixed(1)} mm di pioggia alla partenza`);
  return { top, bottom, label: top, score: Math.round(0.7 * topScore + 0.3 * bottomScore), notes };
}

function weatherOfDay(ctx) {
  const t = ctx.today;
  let score = 100;
  const notes = [];
  if (t.wind_day > 50) { score -= 50; notes.push(`vento molto forte in quota (${t.wind_day} km/h)`); }
  else if (t.wind_day > 30) { score -= 25; notes.push(`vento forte in quota (${t.wind_day} km/h)`); }
  if (t.cloud_day > 80) { score -= 25; notes.push("cielo coperto, visibilità ridotta"); }
  if (t.snowfall_cm > 5) { score -= 25; notes.push(`nevicata durante il giorno (${t.snowfall_cm} cm)`); }
  return { score: Math.max(0, score), notes };
}

// ----------------------------------------------------------------- analisi gita

function slopeRF(slope) {
  if (slope < 30) return 4;
  if (slope < 35) return 3;
  if (slope < 40) return 2;
  return 1;
}

export function riskClass(r) {
  if (r > 1) return "high";
  if (r > 0.5) return "mid";
  return "low";
}

export function analyzeRoute(route, bulletins, date, opts = {}) {
  const groupRF = GROUP_FACTORS[opts.group ?? "small"].rf;
  const bull = bulletinFor(bulletins, date, route.region);
  const ctx = meteoContext(route, date);

  const points = route.track.map((p) => {
    const danger = dangerAt(bull, p.ele);
    const problems = problemsAt(bull, p.ele, p.aspect);
    const lee = ctx.lee.includes(p.aspect) && p.slope_max >= 28;
    // Munter semplificato: DP / (RF pendenza × RF esposizione × RF gruppo)
    const aspectRF = danger >= 4 || problems.length ? 1 : 4;
    const risk = (DANGER_POTENTIAL[danger] ?? 1) / (slopeRF(p.slope_max) * aspectRF * groupRF);
    return { ...p, danger, problems, lee, risk, rc: riskClass(risk) };
  });

  // tratti continui con rischio oltre soglia
  const segments = [];
  let cur = null;
  points.forEach((p, i) => {
    if (p.rc === "high") {
      if (!cur) cur = { from: i, to: i };
      else cur.to = i;
    } else if (cur) { segments.push(cur); cur = null; }
  });
  if (cur) segments.push(cur);
  segments.forEach((s) => {
    s.d0 = points[s.from].d; s.d1 = points[s.to].d;
    s.length = Math.max(25, s.d1 - s.d0);
    s.ele0 = Math.round(points[s.from].ele); s.ele1 = Math.round(points[s.to].ele);
  });
  const exposure = segments.reduce((s, x) => s + x.length, 0);

  const maxDanger = Math.max(...points.map((p) => p.danger));
  const riskMax = Math.max(...points.map((p) => p.risk));
  const leeShare = points.filter((p) => p.lee).length / points.length;
  const snow = snowQuality(ctx);
  const weather = weatherOfDay(ctx);

  const safety = Math.max(0, 100 - 20 * (maxDanger - 1) - 40 * Math.min(exposure / 400, 1)
    - 30 * Math.min(leeShare / 0.3, 1));
  let score = Math.round(0.6 * safety + 0.25 * snow.score + 0.15 * weather.score);
  let verdict;
  if (exposure > 100) { verdict = "no"; score = Math.min(score, 30); }
  else if (exposure > 0 || maxDanger >= 3) verdict = "caution";
  else verdict = "go";

  const reasons = [];
  if (bull) reasons.push(`Pericolo ${DANGER[maxDanger].short.toLowerCase()} (${maxDanger}) sulle quote della gita`);
  if (exposure > 0)
    reasons.push(`${Math.round(exposure)} m di traccia oltre la soglia di rischio (${segments.length} tratt${segments.length > 1 ? "i" : "o"})`);
  else reasons.push("Nessun tratto oltre la soglia di rischio");
  if (leeShare > 0.05)
    reasons.push(`${Math.round(leeShare * 100)}% della traccia su pendii sottovento (vento da ${ctx.windDir})`);

  return {
    route, date, bull, ctx, points, segments, exposure, maxDanger, riskMax,
    leeShare, snow, weather, safety: Math.round(safety), score, verdict, reasons,
  };
}

export const VERDICT = {
  go: { label: "Consigliata", icon: "✓" },
  caution: { label: "Con cautela", icon: "!" },
  no: { label: "Sconsigliata", icon: "✕" },
};

/** Testo sintetico sull'evoluzione dei giorni precedenti. */
export function evolutionText(route, bulletins, date) {
  const days = [3, 2, 1, 0].map((n) => addDays(date, -n));
  const lv = days.map((d) => bulletinFor(bulletins, d, route.region)?.max_level ?? 0);
  const ctx = meteoContext(route, date);
  const parts = [];
  const trend = lv[3] - lv[0];
  if (trend > 0) parts.push(`Il pericolo è salito da ${lv[0]} a ${lv[3]} negli ultimi 3 giorni.`);
  else if (trend < 0) parts.push(`Il pericolo è sceso da ${lv[0]} a ${lv[3]} negli ultimi 3 giorni.`);
  else parts.push(`Il pericolo è stabile a ${lv[3]} negli ultimi 3 giorni.`);
  if (ctx.new72 > 0) parts.push(`In vetta sono caduti ${ctx.new72} cm di neve fresca.`);
  if (ctx.windMax >= 30)
    parts.push(`Vento fino a ${ctx.windMax} km/h da ${ctx.windDir}: accumuli probabili sui versanti ${ctx.lee.join("-")}.`);
  if (ctx.warm) parts.push("Lo zero termico vicino alla vetta o la pioggia indicano croste da rigelo.");
  return parts.join(" ");
}
