#!/usr/bin/env python3
"""Export the RW9 twin as a 30-second step table that the browser interpolates.

Axes: starting voltage, starting temperature, charge current, previous current.
The previous current reproduces the five-sample handover the study inserts when
the current changes. No voltage ceiling is applied here; the page cuts at the
ceiling exactly as ``single_step`` does.

The voltage axis is 0.05 V apart below 4.05 V and 0.025 V apart above it, where
the constant-voltage hold makes the response sharp.

    python twin/export_pack.py          # writes data/pack.js (about 2-4 min on a laptop CPU)
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import numpy as np
import torch

import rw9_twin as T

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "pack.js"
STEP_S = 30
BATCH = 512


def main() -> None:
    torch.set_num_threads(max(1, torch.get_num_threads()))
    model = T.load_twin()
    soc, ocv = T.ocv("RW9")
    v0_start = float(np.interp(0.20, soc, ocv))
    s = np.linspace(0.1, 0.9, 81)
    v_nom = float(np.mean(np.interp(s, soc, ocv)))  # mean OCV over 10-90 %, as in twin.OcvCurve

    v_axis = np.round(np.r_[np.arange(3.50, 4.05 - 1e-9, 0.05), np.arange(4.05, 4.30 + 1e-9, 0.025)], 3)
    t_axis = np.arange(18.0, 30.0 + 1e-9, 2.0)
    i_axis = np.asarray([0.0, 0.05, 0.25, 0.50, 0.75, 1.00, 1.10, 1.25, 1.50, 1.75,
                         2.00, 2.20, 2.50, 2.75, 3.00, 3.50, 4.00, 4.40, 4.616])
    grid = np.stack(np.meshgrid(v_axis, t_axis, i_axis, i_axis, indexing="ij"), -1).reshape(-1, 4)
    n = grid.shape[0]
    volt = np.empty((n, STEP_S), np.int16)
    temp = np.empty((n, STEP_S), np.int16)
    t_start = time.time()
    for a in range(0, n, BATCH):
        g = grid[a:a + BATCH]
        v, t = T.step_batch(model, g[:, 0], g[:, 1], g[:, 2], g[:, 3], STEP_S)
        volt[a:a + BATCH] = np.clip(np.round((v - 3.0) * 10000.0), -32768, 32767)
        temp[a:a + BATCH] = np.clip(np.round(t * 100.0), -32768, 32767)
        if (a // BATCH) % 20 == 0:
            print(f"{a + len(g)}/{n}  {time.time() - t_start:.0f}s", flush=True)

    b64 = lambda arr: base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")
    payload = {
        "twin": "twin/checkpoints/twin_source_RW9.pt",
        "quant": {"v_off": 3.0, "v_scale": 10000.0, "t_scale": 100.0},
        "v_nom": v_nom, "v0_soc20": v0_start, "t0_c": 24.0, "q_ah": 2.2,
        "soc_start": 0.20, "v_max": 4.20, "i_max_a": 4.616, "step_s": STEP_S,
        "v_axis": v_axis.tolist(), "t_axis": t_axis.tolist(), "i_axis": i_axis.tolist(),
        "ocv_soc": [round(float(x), 6) for x in soc], "ocv_v": [round(float(x), 4) for x in ocv],
        "volt_b64": b64(volt), "temp_b64": b64(temp),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, separators=(",", ":"))
    OUT.write_text("globalThis.PACK_DATA = " + raw + ";\n", encoding="utf-8")
    print(f"wrote {OUT}  {len(raw) / 1e6:.1f} MB  in {time.time() - t_start:.0f}s")


if __name__ == "__main__":
    main()
