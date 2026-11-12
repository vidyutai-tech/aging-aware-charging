"""RW9 battery digital twin: load the frozen checkpoint and predict voltage and temperature.

The network class is a verbatim copy of ``BatteryDigitalTwin`` in
``Final_Aging_aware_charging_opt/twin.py`` (v9 transformer decoder). The step
function reproduces ``FrozenBDT.single_step`` from the same file: a decision of
``n_steps`` one-second samples, a five-sample handover at the previous current
when the current changes, and a cut at the first sample at or above the voltage
ceiling.

Inputs to the network: relative age (0 for the fresh cell), starting voltage V0,
starting temperature T0, and a current sequence in amperes (negative while
charging, NASA sign). Output: voltage and temperature for every sample.

Run ``python twin/rw9_twin.py --amps 1.1 --minutes 20`` to print a constant-current
charge from 20 % state of charge.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import torch
import torch.nn as nn

HERE = Path(__file__).resolve().parent
CHECKPOINT = HERE / "checkpoints" / "twin_source_RW9.pt"
OCV_NPZ = HERE / "ocv_curves.npz"


class BatteryDigitalTwin(nn.Module):
    """v9-style twin: 3-scalar initial state (age, V0, T0), no ambient."""

    def __init__(self, seq_len=150, d_model=150, nhead=20, num_layers=1, dropout=0.1,
                 temp_delta_scale=0.1, author_style=True):
        super().__init__()
        self.seq_len = seq_len
        self.d_model = d_model
        self.temp_delta_scale = float(temp_delta_scale)
        self.author_style = bool(author_style)
        full_dim = 2 * d_model
        self.linear_in = nn.Linear(5, d_model)
        self.linear_in_1 = nn.Linear(d_model, d_model)
        self.positional_encoding = nn.Parameter(torch.zeros(seq_len, d_model))
        decoder_layer = nn.TransformerDecoderLayer(
            d_model=full_dim, nhead=nhead, dropout=dropout, batch_first=True,
        )
        self.transformer_decoder = nn.TransformerDecoder(decoder_layer, num_layers)
        self.linear_out1 = nn.Linear(full_dim, 5 * 2)
        self.linear_out2 = nn.Linear(5 * 2, 2 * 2)
        self.linear_out3 = nn.Linear(2 * 2, 2)
        self.gelu = nn.GELU()

    def forward(self, age, v0, t0, current_seq):
        batch_size, steps = current_seq.shape
        initial_state = torch.stack([age, v0, t0], dim=-1)
        scaled_state = initial_state.clone()
        scaled_state[:, 1] = scaled_state[:, 1] / 3.0
        scaled_state[:, 2] = scaled_state[:, 2] / 30.0
        actions = (current_seq / 5.0).unsqueeze(-1)
        actions_delta = actions.clone()
        actions_delta[:, :-1, :] = actions[:, :-1, :] - actions[:, 1:, :]
        actions_delta[:, -1, :] = 0.0
        state_repeated = scaled_state.unsqueeze(1).expand(batch_size, steps, 3)
        x = torch.cat([state_repeated, actions, actions_delta], dim=-1)
        if self.author_style:
            x = self.linear_in_1(self.linear_in(x))
        else:
            x = self.gelu(self.linear_in_1(self.gelu(self.linear_in(x))))
        pos = self.positional_encoding[:steps].unsqueeze(0).expand(batch_size, -1, -1)
        x = torch.cat([x, pos], dim=-1)
        mask = nn.Transformer.generate_square_subsequent_mask(steps, device=x.device)
        y = self.transformer_decoder(x, x, tgt_mask=mask)
        r = self.gelu(self.linear_out1(y))
        r = self.gelu(self.linear_out2(r))
        r = self.linear_out3(r)
        base_v = initial_state[:, 1].unsqueeze(1).expand(batch_size, steps)
        base_t = initial_state[:, 2].unsqueeze(1).expand(batch_size, steps)
        return base_v + r[:, :, 0], base_t + r[:, :, 1] * self.temp_delta_scale


def load_twin(checkpoint: Path = CHECKPOINT) -> BatteryDigitalTwin:
    """Load tensors only (``weights_only=True``), so no pickled code runs."""
    ck = torch.load(Path(checkpoint), map_location="cpu", weights_only=True)
    model = BatteryDigitalTwin(
        seq_len=int(ck.get("seq_len", 150)),
        d_model=int(ck.get("twin_d_model", 150)),
        nhead=int(ck.get("twin_nhead", 20)),
        num_layers=int(ck.get("twin_num_layers", 1)),
        dropout=float(ck.get("twin_dropout", 0.1)),
        temp_delta_scale=float(ck.get("temp_delta_scale", 0.1)),
    )
    model.load_state_dict(ck["model_state"])
    model.eval()
    for p in model.parameters():
        p.requires_grad_(False)
    return model


def windows(v0, t0, amps, prev_amps, n_steps: int, seq_len: int = 150, pad: int = 5):
    """Build the padded network inputs that ``single_step`` would use.

    All arguments are arrays of equal length; currents are charge magnitudes
    (positive). Returns tensors and the per-row handover length.
    """
    v0 = np.asarray(v0, np.float32)
    n = v0.size
    cur = np.zeros((n, seq_len), np.float32)
    pads = np.where(np.abs(np.asarray(prev_amps) - np.asarray(amps)) > 1e-9, pad, 0)
    for k in range(n):
        p = int(pads[k])
        cur[k, :p] = -float(prev_amps[k])
        cur[k, p:p + n_steps] = -float(amps[k])
    return (torch.zeros(n), torch.from_numpy(v0), torch.from_numpy(np.asarray(t0, np.float32)),
            torch.from_numpy(cur), pads)


@torch.no_grad()
def step_batch(model, v0, t0, amps, prev_amps, n_steps: int = 30) -> Tuple[np.ndarray, np.ndarray]:
    """Voltage and temperature for one decision, many starting points at once."""
    age, v, t, cur, pads = windows(v0, t0, amps, prev_amps, n_steps, model.seq_len)
    vo, to = model(age, v, t, cur)
    vo, to = vo.numpy(), to.numpy()
    out_v = np.stack([vo[k, pads[k]:pads[k] + n_steps] for k in range(len(pads))])
    out_t = np.stack([to[k, pads[k]:pads[k] + n_steps] for k in range(len(pads))])
    return out_v, out_t


def ocv(cell: str = "RW9") -> Tuple[np.ndarray, np.ndarray]:
    blob = np.load(OCV_NPZ)
    return np.asarray(blob[f"{cell}_soc"], float), np.asarray(blob[f"{cell}_ocv"], float)


def v_at_soc(soc: float, cell: str = "RW9") -> float:
    s, v = ocv(cell)
    return float(np.interp(soc, s, v))


def constant_current_charge(model, amps: float, minutes: float, soc0: float = 0.20,
                            t0: float = 24.0, v_ceiling: float = 4.20) -> Dict[str, np.ndarray]:
    """Closed-loop constant-current charge in 30-second decisions, stopping at the ceiling."""
    q_as = 2.2 * 3600.0
    v, t, prev = v_at_soc(soc0), t0, 0.0
    vs, ts = [], []
    for _ in range(int(minutes * 2)):
        vv, tt = step_batch(model, [v], [t], [amps], [prev])
        vv, tt = vv[0], tt[0]
        over = np.flatnonzero(vv >= v_ceiling)
        if over.size:
            vv, tt = vv[: over[0] + 1], tt[: over[0] + 1]
        vs.extend(vv.tolist()); ts.extend(tt.tolist())
        v, t, prev = float(vv[-1]), float(tt[-1]), amps
        if over.size:
            break
    n = len(vs)
    return {
        "time_s": np.arange(n, dtype=float),
        "voltage_v": np.asarray(vs),
        "temperature_c": np.asarray(ts),
        "soc": soc0 + amps * np.arange(1, n + 1) / q_as,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--amps", type=float, default=1.1, help="charge current, A (1.1 A = 0.5C)")
    ap.add_argument("--minutes", type=float, default=30.0)
    ap.add_argument("--soc0", type=float, default=0.20)
    ap.add_argument("--t0", type=float, default=24.0)
    ap.add_argument("--csv", type=Path, help="write the one-second trace here")
    args = ap.parse_args()
    model = load_twin()
    n_par = sum(p.numel() for p in model.parameters())
    print(f"RW9 twin: {n_par:,} parameters, window {model.seq_len} s")
    print(f"V0 at {args.soc0:.0%} SOC from the RW9 OCV curve: {v_at_soc(args.soc0):.4f} V")
    run = constant_current_charge(model, args.amps, args.minutes, args.soc0, args.t0)
    for k in range(0, run["time_s"].size, 60):
        print(f"t={k/60:5.1f} min  SOC={run['soc'][k]*100:5.1f}%  V={run['voltage_v'][k]:.4f}  T={run['temperature_c'][k]:.2f} C")
    print(f"end   {run['time_s'].size/60:5.1f} min  V={run['voltage_v'][-1]:.4f}")
    if args.csv:
        with args.csv.open("w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["time_s", "soc", "voltage_v", "temperature_c"])
            for row in zip(run["time_s"], run["soc"], run["voltage_v"], run["temperature_c"]):
                w.writerow([f"{x:.5f}" for x in row])
        print(f"wrote {args.csv}")


if __name__ == "__main__":
    main()
