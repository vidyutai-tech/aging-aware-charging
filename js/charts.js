/** Line charts with axes, a hover readout, an optional time cursor, and a resize listener. */

function niceStep(span, target = 5) {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const err = raw / pow;
  const nice = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  return nice * pow;
}

function formatTick(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, Math.ceil(-Math.log10(step)));
  return v.toFixed(Math.min(d, 3));
}

export function mountChart(canvas) {
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  canvas.parentElement.appendChild(tip);
  const ctx = canvas.getContext("2d");
  let spec = null;
  let frame = null;
  let sized = "";

  function layout() {
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 220;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${cssW}x${cssH}x${dpr}`;
    if (key !== sized) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      sized = key;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH, padL: 52, padR: 14, padT: 24, padB: 40 };
  }

  function draw() {
    if (!spec) return;
    const box = layout();
    const { w, h, padL, padR, padT, padB } = box;
    ctx.clearRect(0, 0, w, h);
    const series = spec.series.filter((s) => s.x && s.x.length);
    if (!series.length) return;
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = spec.yMin ?? Infinity;
    let yMax = spec.yMax ?? -Infinity;
    for (const s of series) {
      for (let i = 0; i < s.x.length; i++) {
        if (s.x[i] < xMin) xMin = s.x[i];
        if (s.x[i] > xMax) xMax = s.x[i];
        if (spec.yMin == null && s.y[i] < yMin) yMin = s.y[i];
        if (spec.yMax == null && s.y[i] > yMax) yMax = s.y[i];
      }
    }
    if (spec.yMin == null || spec.yMax == null) {
      const span = yMax - yMin || 1;
      if (spec.yMin == null) yMin -= span * 0.08;
      if (spec.yMax == null) yMax += span * 0.08;
    }
    if (xMax <= xMin) xMax = xMin + 1;
    if (yMax <= yMin) yMax = yMin + 1;
    const pw = w - padL - padR;
    const ph = h - padT - padB;
    const xOf = (x) => padL + ((x - xMin) / (xMax - xMin)) * pw;
    const yOf = (y) => padT + ((yMax - y) / (yMax - yMin)) * ph;

    ctx.font = "12px Charter, 'Iowan Old Style', Georgia, serif";
    ctx.strokeStyle = "#e3e8f2";
    ctx.fillStyle = "#5b6478";
    ctx.lineWidth = 1;
    const xStep = niceStep(xMax - xMin, 6);
    const yStep = niceStep(yMax - yMin, 4);
    const x0 = Math.ceil(xMin / xStep) * xStep;
    const y0 = Math.ceil(yMin / yStep) * yStep;
    for (let x = x0; x <= xMax + 1e-9; x += xStep) {
      const px = xOf(x);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + ph);
      ctx.stroke();
      ctx.fillText(formatTick(x, xStep), px - 8, h - 16);
    }
    for (let y = y0; y <= yMax + 1e-9; y += yStep) {
      const py = yOf(y);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + pw, py);
      ctx.stroke();
      ctx.fillText(formatTick(y, yStep), 6, py + 4);
    }
    ctx.fillStyle = "#1d2433";
    ctx.font = "bold 12px Charter, 'Iowan Old Style', Georgia, serif";
    ctx.fillText(spec.yLabel, padL, 13);
    ctx.textAlign = "center";
    ctx.fillText(spec.xLabel, padL + pw / 2, h - 3);
    ctx.textAlign = "left";
    ctx.font = "12px Charter, 'Iowan Old Style', Georgia, serif";

    for (const g of spec.guides || []) {
      ctx.save();
      ctx.strokeStyle = g.color || "#c2410c";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, yOf(g.y));
      ctx.lineTo(padL + pw, yOf(g.y));
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT - 2, pw, ph + 4);
    ctx.clip();
    for (const s of series) {
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 2;
      ctx.setLineDash(s.dash || []);
      for (let i = 0; i < s.x.length; i++) {
        const px = xOf(s.x[i]);
        const py = yOf(s.y[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    if (spec.cursorX != null && spec.cursorX >= xMin && spec.cursorX <= xMax) {
      const px = xOf(spec.cursorX);
      ctx.save();
      ctx.strokeStyle = "#3456d1";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + ph);
      ctx.stroke();
      ctx.restore();
    }

    if (spec.hoverIndex != null && series[0]) {
      const s0 = series[0];
      const i = Math.min(spec.hoverIndex, s0.x.length - 1);
      const px = xOf(s0.x[i]);
      ctx.save();
      ctx.strokeStyle = "#1d2433";
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + ph);
      ctx.stroke();
      ctx.restore();
    }
    canvas._plot = { xOf, yOf, xMin, xMax, padL, padR, w, series };
  }

  function nearest(evt) {
    const plot = canvas._plot;
    if (!plot || !spec) return;
    const rect = canvas.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const { xMin, xMax, padL, w } = plot;
    const padR = plot.padR;
    const x = xMin + ((px - padL) / (w - padL - padR)) * (xMax - xMin);
    const s0 = plot.series[0];
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < s0.x.length; i += Math.ceil(s0.x.length / 400)) {
      const d = Math.abs(s0.x[i] - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const lo = Math.max(0, best - 8);
    const hi = Math.min(s0.x.length - 1, best + 8);
    for (let i = lo; i <= hi; i++) {
      const d = Math.abs(s0.x[i] - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    spec.hoverIndex = best;
    const lines = plot.series.map((s) => {
      const j = Math.min(best, s.x.length - 1);
      return `${s.name}: ${spec.formatY ? spec.formatY(s.y[j]) : s.y[j].toFixed(2)}`;
    });
    const xText = spec.formatX ? spec.formatX(s0.x[best]) : s0.x[best].toFixed(1);
    tip.hidden = false;
    tip.textContent = `${spec.xLabel.split("(")[0].trim()} ${xText} · ${lines.join(" · ")}`;
    tip.style.left = `${Math.min(px + 12, rect.width - 180)}px`;
    tip.style.top = "8px";
    draw();
  }

  canvas.addEventListener("mousemove", nearest);
  canvas.addEventListener("mouseleave", () => {
    if (spec) spec.hoverIndex = null;
    tip.hidden = true;
    draw();
  });
  const observer = new ResizeObserver(() => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });
  observer.observe(canvas);

  return {
    set(next) {
      spec = next;
      draw();
    },
    cursor(x) {
      if (!spec) return;
      spec.cursorX = x;
      draw();
    },
  };
}
