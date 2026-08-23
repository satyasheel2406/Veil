"""Latency probe: measures end-to-end plan round-trips against a live server.

Sends N synthetic login-screen perception frames over WebSocket and reports
client-observed wall time and server-reported planner time with percentiles.
This is the evidence tool for the SIH latency criterion (p50 <= 3.5 s).

Usage:
    python eval/latency_probe.py --runs 20 --budget-ms 3500
    python eval/latency_probe.py --check   # exit 1 if p50 exceeds budget
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import uuid
from typing import Any

import websockets


def _screen(seq: int) -> dict[str, Any]:
    return {
        "url_skeleton": "https://demo.bank.example/**",
        "title": "Nebula Bank - Sign in",
        "viewport": {"w": 1280, "h": 800},
        "scroll": {"x": 0, "y": 0},
        "frame_hash": f"probe-{seq}",
        "elements": [
            {
                "id": 0,
                "role": "textbox",
                "tag": "input",
                "name": "[EMAIL_1] address",
                "value": None,
                "editable": True,
                "rect": {"x": 100, "y": 200, "w": 300, "h": 32},
                "in_viewport": True,
                "attributes": {"type": "email"},
            },
            {
                "id": 1,
                "role": "textbox",
                "tag": "input",
                "name": "Password",
                "value": None,
                "editable": True,
                "rect": {"x": 100, "y": 240, "w": 300, "h": 32},
                "in_viewport": True,
                "attributes": {"type": "password"},
            },
            {
                "id": 2,
                "role": "button",
                "tag": "button",
                "name": "Sign in",
                "value": None,
                "editable": False,
                "rect": {"x": 100, "y": 290, "w": 140, "h": 36},
                "in_viewport": True,
                "attributes": {},
            },
        ],
        "pii_refs": [
            {"ref": "[EMAIL_1]", "kind": "email"},
            {"ref": "[PASSWORD_1]", "kind": "password"},
        ],
        "redaction_count": 2,
        "image_regions": [],
    }


def _timings() -> dict[str, Any]:
    return {
        "extract_ms": 4.2,
        "redact_ms": 1.8,
        "serialize_ms": 0.6,
        "capture_ms": 38.0,
        "vision_ms": 61.0,
        "rtt_ms": None,
    }


async def probe(url: str, runs: int, budget_ms: float, check: bool) -> int:
    session = f"probe-{uuid.uuid4().hex[:10]}"
    client_totals: list[float] = []
    server_usages: list[float] = []
    errors = 0
    model = "?"

    for i in range(1, runs + 1):
        try:
            async with websockets.connect(url) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "type": "hello",
                            "v": 1,
                            "session": session,
                            "caps": {"webgpu": False, "dpr": 1},
                        }
                    )
                )
                welcome = json.loads(await ws.recv())

                loop = asyncio.get_running_loop()
                t0 = loop.time()
                await ws.send(
                    json.dumps(
                        {
                            "type": "perception",
                            "seq": i,
                            "task": "Log in to my account",
                            "screen": _screen(i),
                            "timings": _timings(),
                        }
                    )
                )
                frame = json.loads(await ws.recv())
                total_ms = (loop.time() - t0) * 1000

                if frame.get("type") != "plan":
                    errors += 1
                    continue
                model = welcome.get("model", "?")
                client_totals.append(total_ms)
                server_usages.append(float(frame.get("usage_ms", 0.0)))
        except Exception as e:
            print(f"run {i}: ERROR {e}")
            errors += 1

    if not client_totals:
        print("PROBE FAILED: no successful runs")
        return 2

    def pct(vals: list[float], p: float) -> float:
        s = sorted(vals)
        k = (len(s) - 1) * p / 100.0
        f, c = int(k), min(int(k) + 1, len(s) - 1)
        return s[f] + (s[c] - s[f]) * (k - f)

    p50 = pct(client_totals, 50)
    p95 = pct(client_totals, 95)

    print(f"latency probe vs {url}")
    print(f"provider/model : {model}")
    print(f"runs           : {len(client_totals)} ok, {errors} failed")
    print(f"client round-trip ms : min={min(client_totals):.1f} p50={p50:.1f} "
          f"p95={p95:.1f} max={max(client_totals):.1f}")
    print(f"server planner ms    : min={min(server_usages):.1f} p50={pct(server_usages, 50):.1f} "
          f"p95={pct(server_usages, 95):.1f} max={max(server_usages):.1f}")

    verdict = "PASS" if p50 <= budget_ms else "FAIL"
    print(f"budget check    : p50 {p50:.1f}ms {'<=' if p50 <= budget_ms else '>'} {budget_ms:.0f}ms -> {verdict}")

    if check:
        return 0 if p50 <= budget_ms else 1
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default="ws://localhost:8765/ws")
    ap.add_argument("--runs", type=int, default=20)
    ap.add_argument("--budget-ms", type=float, default=3500.0)
    ap.add_argument("--check", action="store_true", help="exit non-zero when budget exceeded")
    args = ap.parse_args()
    sys.exit(asyncio.run(probe(args.url, args.runs, args.budget_ms, args.check)))


if __name__ == "__main__":
    main()
