import { mountChart } from "./charts.js";
import { capacityCurve } from "./life.js";
import { END_TEXT, FAMILIES, baselineParams, describeParams } from "./profiles.js";
import { Q_AH, SOC_START, SPACE, V_MAX, tripDemand } from "./physics.js";
import { planCharge } from "./search.js";
import { rollout } from "./simulate.js";
import { loadTwin } from "./twin.js";

const $ = (id) => document.getElementById(id);
const form = $("planner");
const out = $("out");
const statusEl = $("status");
const progress = $("progress");
const bar = $("bar");
const go = $("go");

const twin = loadTwin(globalThis.PACK_DATA);
const charts = {};
let player = null;

const num = (id) => Number($(id).value);

function fmt(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return "–";
  if (!Number.isFinite(n)) return "never";
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
const sci = (n) => (n > 0 ? n.toExponential(2) : "–");
const methodName = (id) => (id === "gp_bo" ? "Gaussian-process" : id === "random_search" ? "Random" : "Standard");

function readRequest() {
  const km = num("km");
  const demand = tripDemand(km, twin.vNom, num("whkm"), Math.round(num("cells")));
  const override = $("override").checked;
  const method = $("method").value;
  return {
    km,
    minutes: num("minutes"),
    demand,
    override,
    energyFraction: override ? Math.min(0.8, Math.max(0.1, num("fraction") / 100)) : demand.energyFraction,
    energyMode: $("stop").value === "energy",
    families: [...form.querySelectorAll('input[name="family"]:checked')].map((el) => el.value),
    methods: method === "both" ? ["random_search", "gp_bo"] : [method],
    nCalls: Math.round(num("trials")),
    nInitial: Math.round(num("warm")),
    acq: $("acq").value,
    seed: Math.round(num("seed")),
    objective: $("objective").value,
    cvMode: $("cvmode").value,
    inWindow: $("inwin").checked,
    refC: Number($("ref").value),
    usage: { hoursBetween: num("hours"), parkC: num("park"), eolPct: num("eol") },
    weights: { wSoc: num("w-soc"), wLoss: num("w-loss"), wTime: num("w-time"), zTime: num("z-time") },
  };
}

function sessionFor(req) {
  return {
    socStart: SOC_START,
    energyFraction: req.energyFraction,
    maxMin: req.minutes,
    energyMode: req.energyMode,
    vMax: V_MAX,
    vNom: twin.vNom,
    qAs: twin.qAs,
    weights: req.weights,
    // Keep step changes inside this charge, and allow at least a few pulses.
    space: req.inWindow
      ? { ...SPACE, // Energy goes in at up to 4.2 V, so the charge ends below start + energy fraction.
        socEnd: SOC_START + (req.energyFraction * twin.vNom) / V_MAX, pulseOnMax: Math.min(SPACE.pulseOnMax, Math.max(2, req.minutes / 3)) }
      : SPACE,
    cvMode: req.cvMode,
    objective: req.objective,
    usage: req.usage,
  };
}

function updatePackNote() {
  const d = tripDemand(num("km"), twin.vNom, num("whkm"), Math.round(num("cells")));
  $("pack-note").textContent = `Pack: ${Math.round(num("cells")).toLocaleString("en-IN")} cells of ${fmt(d.fullWh, 2)} Wh, about ${fmt(d.packCapacityKwh, 1)} kWh. Each charge starts at ${Math.round(SOC_START * 100)}%. Between charges the car is parked at the average of its start and end charge.`;
}

/* ---------- rendering ---------- */

function within(m, end, minutes) {
  if (m.durationMin > minutes + 1e-9) return `Needs ${fmt(m.durationMin, 0)} min`;
  if (m.feasible) return "Yes";
  if (m.eNorm < 1 - 1e-3) return end === "time budget" ? "Ran out of time" : "Fell short";
  return "Went over 4.2 V";
}

function phaseAt(trace, k) {
  if (k >= trace.current.length) return "Finished";
  const amps = -trace.current[k];
  if (amps <= 0) return "Resting";
  const cvAt = trace.metrics.cvStartMin;
  if (trace.voltage[k] >= V_MAX - 1e-6 || (cvAt != null && k / 60 >= cvAt)) return "Holding the voltage";
  return "Constant current";
}

function seriesFrom(trace, name, color, dash) {
  const n = trace.current.length;
  const t = new Array(n);
  const amps = new Array(n);
  const soc = new Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = i / 60;
    amps[i] = Math.max(0, -trace.current[i]);
    soc[i] = trace.metrics.soc[i] * 100;
  }
  return {
    amps: { name, color, dash, x: t, y: amps },
    voltage: { name, color, dash, x: t, y: trace.voltage },
    temp: { name, color, dash, x: t, y: trace.temperature },
    soc: { name, color, dash, x: t, y: soc },
  };
}

function cellCard(cls, title) {
  return `<article class="cell-card ${cls}">
    <h4>${title}</h4>
    <div class="cell-row">
      <div class="jar"><div class="fill" data-k="fill"></div><div class="pct" data-k="pct"></div></div>
      <dl class="readout">
        <div><dt>Current</dt><dd data-k="amps"></dd></div>
        <div><dt>Voltage</dt><dd data-k="volt"></dd></div>
        <div><dt>Temperature</dt><dd data-k="temp"></dd></div>
        <div><dt>Energy in</dt><dd data-k="energy"></dd></div>
        <div class="phase" data-k="phase"></div>
      </dl>
    </div>
  </article>`;
}

function render(req, view) {
  const { ref, best, top, baselines, tested } = view;
  const usage = req.usage;
  const bL = best.metrics.life;
  const rL = ref.metrics.life;
  const refName = `CCCV ${ref.c}C`;
  const lifeGain = Number.isFinite(bL.charges) && Number.isFinite(rL.charges) ? (bL.charges / rL.charges - 1) * 100 : null;

  const warn = [];
  if (req.demand.capped && !req.override) {
    warn.push(`A charge from 20% cannot hold this whole trip. The plan uses the largest charge that fits, enough for about ${fmt(req.demand.maxKm, 0)} km.`);
  }
  if (!best.metrics.feasible) warn.push(`No schedule delivered the trip energy within ${fmt(req.minutes, 0)} min and 4.2 V. Allow more time or a shorter trip.`);
  const refLate = ref.metrics.durationMin > req.minutes + 1e-9;
  if (refLate) warn.push(`The ${refName} charge needs ${fmt(ref.metrics.durationMin, 0)} min, more than the ${fmt(req.minutes, 0)} min you have. It is shown for comparison.`);
  else if (!ref.metrics.feasible) warn.push(`The ${refName} charge does not stay within the limits. It is still shown for comparison.`);

  const used = best.metrics.durationMin;
  const timeLine = `It takes ${fmt(used, 1)} of your ${fmt(req.minutes, 0)} minutes`;
  const cmpTime = ref.metrics.durationMin - used;
  const cmpLine = lifeGain == null ? "" : Math.abs(lifeGain) < 1
    ? `Pack life is about the same as with the ${refName} charge.`
    : lifeGain > 0
      ? `That is ${fmt(lifeGain, 0)}% more charges than the ${refName} charge${cmpTime < -0.5 ? `, which would finish ${fmt(-cmpTime, 1)} min sooner` : ""}.`
      : refLate
        ? `That is ${fmt(-lifeGain, 0)}% fewer charges than the ${refName} charge, which would need ${fmt(ref.metrics.durationMin, 0)} min.`
        : `That is ${fmt(-lifeGain, 0)}% fewer charges than the ${refName} charge${cmpTime > 0.5 ? `, the price of finishing ${fmt(cmpTime, 1)} min sooner` : ""}.`;

  const splitRows = [...baselines, { ...best, name: "Recommended" }].map((row) => {
    const L = row.metrics.life;
    return { name: row.name, cal: L.calShare, charges: L.charges, years: L.years };
  });

  out.innerHTML = `
  <section class="result" aria-labelledby="res-title">
    <h2 class="result-title" id="res-title">The recommended charge</h2>
    <p class="result-lede">${tested} schedules were tried on the RW9 twin. ${req.objective === "life" ? "The one shown gives the longest pack life among those that deliver the trip energy in time." : "The one shown has the best study score."}</p>
    ${warn.map((t) => `<div class="banner">${t}</div>`).join("")}

    <div class="verdict">
      <div>
        <div class="big">${fmt(bL.years, 1)} years</div>
        <p class="big-sub">until the pack is down to ${usage.eolPct}% capacity, charging this way every ${fmt(usage.hoursBetween, 0)} h.</p>
      </div>
      <div class="vcard best"><div class="k">Recommended, charges to ${usage.eolPct}%</div><div class="v">${fmt(bL.charges, 0)}</div><div class="s">${fmt(best.metrics.durationMin, 1)} min per charge</div></div>
      <div class="vcard ref"><div class="k">${refName}, charges to ${usage.eolPct}%</div><div class="v">${fmt(rL.charges, 0)}</div><div class="s">${fmt(ref.metrics.durationMin, 1)} min per charge, ${fmt(rL.years, 1)} years</div></div>
    </div>

    <p class="story">For ${fmt(req.km, 0)} km the pack needs ${fmt(req.demand.packKwh, 1)} kWh, so each cell gains ${fmt(req.energyFraction * 100, 1)}% charge. The recommended charge is <strong>${best.family}</strong>: ${describeParams(best.familyId, best.params, best.metrics.socEnd, best.metrics.durationMin)}. ${timeLine}. ${cmpLine}</p>

    <h3 class="sub-title">The charge, minute by minute</h3>
    <p class="sub-lede">Both charges on the same cell model. Drag the slider or press Play.</p>
    <div class="live">${cellCard("best", "Recommended")}${cellCard("ref", refName)}</div>
    <div class="player">
      <button type="button" id="play">Play</button>
      <input type="range" id="scrub" min="0" max="100" value="0" step="1" aria-label="Time into the charge">
      <output id="clock">0.0 min</output>
    </div>
    <div class="charts">
      <article class="panel"><h4>Charge current</h4>${legend(refName)}<div class="plot"><canvas id="c-i"></canvas></div></article>
      <article class="panel"><h4>Cell voltage</h4>${legend(refName, true)}<div class="plot"><canvas id="c-v"></canvas></div></article>
      <article class="panel"><h4>Cell temperature</h4>${legend(refName)}<div class="plot"><canvas id="c-t"></canvas></div></article>
      <article class="panel"><h4>State of charge</h4>${legend(refName)}<div class="plot"><canvas id="c-s"></canvas></div></article>
    </div>

    <h3 class="sub-title">Pack life</h3>
    <p class="sub-lede">Capacity after repeated charges like this one, with calendar aging counted on real time: the charge itself plus ${fmt(Math.max(0, usage.hoursBetween - used / 60), 1)} h parked at ${fmt(usage.parkC, 0)} °C until the next charge.</p>
    <div class="charts">
      <article class="panel wide">
        <div class="legend"><span><i class="sw best"></i>Recommended</span><span><i class="sw ref"></i>${refName}</span><span><i class="sw cal"></i>Calendar aging alone</span><span><i class="sw lim"></i>End of life</span></div>
        <div class="plot tall"><canvas id="c-life"></canvas></div>
      </article>
    </div>
    <h3 class="sub-title">Where the aging comes from</h3>
    <p class="sub-lede">How the ${100 - usage.eolPct}% capacity loss at end of life splits between calendar and cycle aging, for each way of charging.</p>
    <div class="split">
      ${splitRows.map((r) => `<div class="split-row"><strong>${r.name}</strong><div class="bar">
        <span class="cal" style="width:${100 * r.cal}%">${r.cal > 0.1 ? `${fmt(100 * r.cal, 0)}%` : ""}</span>
        <span class="cyc" style="width:${100 * (1 - r.cal)}%">${1 - r.cal > 0.1 ? `${fmt(100 * (1 - r.cal), 0)}%` : ""}</span></div>
        <span class="total">${fmt(r.charges, 0)} charges</span></div>`).join("")}
    </div>
    <div class="key"><span><i style="background:#7b8bb5"></i>Calendar aging</span><span><i style="background:var(--blue)"></i>Cycle aging</span></div>

    <h3 class="sub-title">Standard charges and the recommendation</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Charge</th><th class="n">Time (min)</th><th class="n">Peak °C</th><th class="n">Charges to ${usage.eolPct}%</th><th class="n">Years</th><th class="n">Calendar share</th><th>Within limits</th></tr></thead>
      <tbody>
        ${baselines.map((r) => tableRow({ ...r, limit: req.minutes }, false)).join("")}
        ${tableRow({ ...best, name: "Recommended", limit: req.minutes }, true)}
      </tbody>
    </table></div>
    <p class="fine">${END_TEXT[best.end] || best.end}. Study per-session wear index for the recommended charge (paper closed form): calendar ${sci(best.metrics.qCalendar)}, cycle ${sci(best.metrics.qCyclic)}. Study score versus ${refName}: ${fmt(best.metrics.reward - ref.metrics.reward, 1)}.</p>

    <h3 class="sub-title">Best of each schedule type</h3>
    <p class="sub-lede">The best schedule found for each type you ticked, then the next best overall. Row 1 is the recommendation, chosen by ${req.objective === "life" ? "pack life" : "the study score"}; both measures are shown for every row.</p>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th>Schedule</th><th>Search</th><th class="n">Time (min)</th><th class="n">Charges to ${usage.eolPct}%</th><th class="n">Life vs ${refName}</th><th class="n">Study score vs ${refName}</th></tr></thead>
      <tbody>
        ${top.map((row, i) => `<tr class="${i === 0 ? "pick" : ""}"><td>${i + 1}</td><td>${row.family}<br><span class="fine">${describeParams(row.familyId, row.params, row.metrics.socEnd, row.metrics.durationMin)}</span></td><td>${methodName(row.method)}</td><td class="n">${fmt(row.metrics.durationMin)}</td><td class="n">${fmt(row.metrics.life.charges, 0)}</td><td class="n">${pct(row.metrics.life.charges / rL.charges - 1)}</td><td class="n">${fmt(row.metrics.reward - ref.metrics.reward, 1)}</td></tr>`).join("")}
      </tbody>
    </table></div>
    <p class="fine">Study score: 1000 × (2.5 × charge added − 7500 × session wear − 1.1 × hours^0.55), the paper's reward. Higher is better. "Not reached" marks a step the charge ended before.</p>

    <h3 class="sub-title">How the trip became a charge</h3>
    <div class="pipeline">
      <div class="pipe"><b>${fmt(req.demand.packKwh, 2)} kWh</b><span>${fmt(req.km, 0)} km at ${fmt(req.demand.whPerKm, 0)} Wh per km.</span></div>
      <div class="pipe"><b>${fmt(req.demand.cellWh, 2)} Wh per cell</b><span>Shared across ${req.demand.nCells.toLocaleString("en-IN")} cells.</span></div>
      <div class="pipe"><b>${fmt(req.energyFraction * 100, 1)}% added</b><span>Each cell holds ${fmt(req.demand.fullWh, 2)} Wh (${Q_AH} Ah at ${fmt(twin.vNom, 2)} V). The charge starts at ${Math.round(SOC_START * 100)}%.</span></div>
      <div class="pipe"><b>${fmt(req.minutes, 0)} min limit</b><span>Current up to ${fmt(SPACE.iMax, 2)} A per cell, voltage up to ${V_MAX.toFixed(1)} V.</span></div>
    </div>
    <p class="fine">The pack is treated as identical cells. Voltage and temperature come from the RW9 twin; ${req.cvMode === "hold" ? "at 4.2 V the current tapers as a charger's voltage hold would, using the cell's open-circuit voltage curve" : "at 4.2 V the study rule lowers the current 0.25 A at each touch"}. Cycle aging counts charge ampere-hours, as in the study's fit.</p>
  </section>`;

  const bestS = seriesFrom(best.trace, "Recommended", "#1f8a55");
  const refS = seriesFrom(ref.trace, refName, "#d9692f", [6, 4]);
  const fx = (x) => `${x.toFixed(1)} min`;
  draw("c-i", { xLabel: "Time (min)", yLabel: "Current (A)", series: [bestS.amps, refS.amps], yMin: 0, formatY: (y) => `${y.toFixed(2)} A`, formatX: fx });
  draw("c-v", { xLabel: "Time (min)", yLabel: "Voltage (V)", series: [bestS.voltage, refS.voltage], guides: [{ y: V_MAX }], yMin: 3.6, yMax: 4.3, formatY: (y) => `${y.toFixed(3)} V`, formatX: fx });
  draw("c-t", { xLabel: "Time (min)", yLabel: "Temperature (°C)", series: [bestS.temp, refS.temp], formatY: (y) => `${y.toFixed(2)} °C`, formatX: fx });
  draw("c-s", { xLabel: "Time (min)", yLabel: "State of charge (%)", series: [bestS.soc, refS.soc], yMin: 0, yMax: 100, formatY: (y) => `${y.toFixed(1)}%`, formatX: fx });

  const nMax = 1.15 * Math.max(Number.isFinite(bL.charges) ? bL.charges : 0, Number.isFinite(rL.charges) ? rL.charges : 0, 100);
  const cb = capacityCurve(bL, nMax);
  const cr = capacityCurve(rL, nMax);
  const yLow = Math.max(0, usage.eolPct - 10);
  draw("c-life", {
    xLabel: "Charges",
    yLabel: "Capacity remaining (%)",
    series: [
      { name: "Recommended", color: "#1f8a55", x: cb.x, y: cb.y },
      { name: refName, color: "#d9692f", dash: [6, 4], x: cr.x, y: cr.y },
      { name: "Calendar alone (recommended)", color: "#7b8bb5", dash: [2, 3], x: cb.x, y: cb.cal },
    ],
    guides: [{ y: usage.eolPct }],
    yMin: yLow,
    yMax: 100,
    formatY: (y) => `${y.toFixed(1)}%`,
    formatX: (x) => `${Math.round(x).toLocaleString("en-IN")} (${fmt((x * usage.hoursBetween) / 8760, 1)} y)`,
  });

  setupPlayer(best.trace, ref.trace);
}

const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, 1)}%` : "–");

function legend(refName, limit = false) {
  return `<div class="legend"><span><i class="sw best"></i>Recommended</span><span><i class="sw ref"></i>${refName}</span>${limit ? '<span><i class="sw lim"></i>4.2 V limit</span>' : ""}</div>`;
}

function tableRow(row, pick) {
  const m = row.metrics;
  const L = m.life;
  return `<tr class="${pick ? "pick" : ""}"><td>${row.name}</td><td class="n">${fmt(m.durationMin)}</td><td class="n">${fmt(m.peakT)}</td><td class="n">${fmt(L.charges, 0)}</td><td class="n">${fmt(L.years, 1)}</td><td class="n">${fmt(L.calShare * 100, 0)}%</td><td>${within(m, row.end, row.limit)}</td></tr>`;
}

function draw(id, spec) {
  const canvas = $(id);
  if (!charts[id]) charts[id] = mountChart(canvas);
  charts[id].set(spec);
}

/* ---------- minute-by-minute player ---------- */

function setupPlayer(bestTrace, refTrace) {
  if (player) cancelAnimationFrame(player.raf);
  const total = Math.max(bestTrace.current.length, refTrace.current.length);
  const scrub = $("scrub");
  const clock = $("clock");
  const playBtn = $("play");
  scrub.max = String(Math.max(1, total - 1));
  const cards = [...document.querySelectorAll(".cell-card")];
  const traces = [bestTrace, refTrace];
  const energyCum = traces.map((tr) => {
    const e = new Float64Array(tr.current.length);
    let acc = 0;
    for (let i = 0; i < tr.current.length; i++) {
      acc += (-tr.current[i] * tr.voltage[i]) / 3600;
      e[i] = acc;
    }
    return e;
  });

  function show(k) {
    clock.textContent = `${(k / 60).toFixed(1)} min`;
    traces.forEach((tr, j) => {
      const card = cards[j];
      const n = tr.current.length;
      const i = Math.min(k, n - 1);
      const soc = tr.metrics.soc[i] * 100;
      const q = (key) => card.querySelector(`[data-k="${key}"]`);
      q("fill").style.height = `${soc}%`;
      q("pct").textContent = `${soc.toFixed(1)}%`;
      q("amps").textContent = k < n ? `${(-tr.current[i]).toFixed(2)} A` : "0 A";
      q("volt").textContent = `${tr.voltage[i].toFixed(3)} V`;
      q("temp").textContent = `${tr.temperature[i].toFixed(1)} °C`;
      q("energy").textContent = `${energyCum[j][i].toFixed(2)} Wh`;
      q("phase").textContent = k >= n ? `Finished at ${(n / 60).toFixed(1)} min` : phaseAt(tr, i);
    });
    for (const c of Object.keys(charts)) if (c !== "c-life") charts[c].cursor(k / 60);
  }

  player = { raf: 0, playing: false };
  scrub.oninput = () => {
    stop();
    show(Number(scrub.value));
  };
  function stop() {
    player.playing = false;
    cancelAnimationFrame(player.raf);
    playBtn.textContent = "Play";
  }
  playBtn.onclick = () => {
    if (player.playing) return stop();
    if (Number(scrub.value) >= total - 1) scrub.value = "0";
    player.playing = true;
    playBtn.textContent = "Pause";
    const startK = Number(scrub.value);
    const t0 = performance.now();
    const spanMs = 9000 * (1 - startK / total);
    const tick = (now) => {
      const f = Math.min(1, (now - t0) / spanMs);
      const k = Math.round(startK + f * (total - 1 - startK));
      scrub.value = String(k);
      show(k);
      if (f < 1 && player.playing) player.raf = requestAnimationFrame(tick);
      else stop();
    };
    player.raf = requestAnimationFrame(tick);
  };
  show(0);
}

/* ---------- run ---------- */

async function run(evt) {
  if (evt) evt.preventDefault();
  const req = readRequest();
  if (!req.families.length) {
    statusEl.textContent = "Choose at least one schedule type in step 3.";
    return;
  }
  go.disabled = true;
  progress.hidden = false;
  bar.style.width = "3%";
  statusEl.textContent = "Charging the standard 0.5C, 1C and 2C schedules…";
  await new Promise((r) => setTimeout(r, 0));
  const session = sessionFor(req);
  // Standard charges run without the time limit so they are compared on a finished charge.
  const open = { ...session, maxMin: Math.max(req.minutes, 300) };
  const baselines = [0.5, 1, 2].map((c) => {
    const params = baselineParams(c);
    const trace = rollout(FAMILIES.cccv, params, open, twin);
    return { name: `CCCV ${c}C`, c, family: "CCCV", familyId: "cccv", params, metrics: trace.metrics, end: trace.end, trace, method: "baseline" };
  });
  const ref = baselines.find((b) => b.c === req.refC) || baselines[0];
  const t0 = performance.now();
  const result = await planCharge(session, twin, req, (frac) => {
    bar.style.width = `${Math.round(3 + frac * 97)}%`;
    statusEl.textContent = `Searching schedules… ${Math.round(frac * 100)}%`;
  });
  const winner = result.top[0];
  const bestTrace = rollout(FAMILIES[winner.familyId], winner.params, session, twin);
  const best = { ...winner, trace: bestTrace, metrics: bestTrace.metrics, end: bestTrace.end };
  result.top[0] = { ...result.top[0], metrics: best.metrics, end: best.end };
  statusEl.textContent = `Solved in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  progress.hidden = true;
  go.disabled = false;
  for (const key of Object.keys(charts)) delete charts[key];
  render(req, { ref, best, top: result.top, baselines, tested: result.tested });
}

function fail(err) {
  statusEl.textContent = "The plan stopped with an error. Details are below.";
  out.innerHTML = `<pre class="banner">${String(err && err.stack ? err.stack : err).replace(/</g, "&lt;")}</pre>`;
  go.disabled = false;
  progress.hidden = true;
}

form.addEventListener("submit", (evt) => run(evt).catch(fail));
for (const btn of document.querySelectorAll(".presets button")) {
  btn.addEventListener("click", () => {
    $("km").value = btn.dataset.km;
    $("minutes").value = btn.dataset.min;
    document.querySelectorAll(".presets button").forEach((b) => b.classList.toggle("on", b === btn));
    updatePackNote();
    run().catch(fail);
  });
}
for (const id of ["km", "whkm", "cells"]) $(id).addEventListener("input", updatePackNote);
updatePackNote();
run().catch(fail);
