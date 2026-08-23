import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.stats import StatsRecorder, _percentile  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def test_percentile_interpolates() -> None:
    vals = sorted([10.0, 20.0, 30.0, 40.0])
    assert _percentile(vals, 50) == 25.0
    assert _percentile(vals, 0) == 10.0
    assert _percentile(vals, 100) == 40.0
    assert _percentile([], 50) == 0.0
    assert _percentile([7.0], 95) == 7.0


def test_recorder_summary_buckets_by_provider() -> None:
    r = StatsRecorder(window=10)
    for ms in (100.0, 200.0, 300.0):
        r.record("echo", "echo-heuristic", usage_ms=ms * 0.5, total_ms=ms, actions=3)
    r.record("groq", "llama-4", usage_ms=900.0, total_ms=1200.0, actions=5)
    r.record_failure()

    s = r.summary()
    assert s["plans"] == 4
    assert s["failures"] == 1
    assert s["total_p50_ms"] == 250.0
    assert s["providers"]["echo"]["count"] == 3
    assert s["providers"]["echo"]["avg_actions"] == 3.0
    assert s["providers"]["groq"]["usage_p50_ms"] == 900.0
    assert s["providers"]["groq"]["last_model"] == "llama-4"


def test_recorder_window_drops_old_entries() -> None:
    r = StatsRecorder(window=3)
    for i in range(5):
        r.record("echo", "m", usage_ms=float(i), total_ms=float(i), actions=1)
    s = r.summary()
    assert s["plans"] == 3
    assert s["total_p50_ms"] == 3.0


def test_stats_endpoint_reflects_traffic() -> None:
    from app.main import create_app

    app = create_app()
    client = TestClient(app)

    before = client.get("/stats").json()
    assert before["ok"] is True
    assert "total_p50_ms" in before

    with client.websocket_connect("/ws") as ws:
        ws.send_json(
            {
                "type": "hello",
                "v": 1,
                "session": "statstest12345",
                "caps": {"webgpu": False, "dpr": 1},
            }
        )
        ws.receive_json()
        ws.send_json(
            {
                "type": "perception",
                "seq": 1,
                "task": "Log in to my account",
                "screen": {
                    "url_skeleton": "https://x/**",
                    "title": "t",
                    "viewport": {"w": 1280, "h": 800},
                    "frame_hash": "h",
                    "elements": [
                        {
                            "id": 0,
                            "role": "textbox",
                            "tag": "input",
                            "name": "[EMAIL_1] address",
                            "value": None,
                            "editable": True,
                            "rect": {"x": 0, "y": 0, "w": 200, "h": 30},
                            "in_viewport": True,
                            "attributes": {"type": "email"},
                        },
                        {
                            "id": 1,
                            "role": "button",
                            "tag": "button",
                            "name": "Sign in",
                            "value": None,
                            "editable": False,
                            "rect": {"x": 0, "y": 40, "w": 100, "h": 30},
                            "in_viewport": True,
                            "attributes": {},
                        },
                    ],
                    "pii_refs": [{"ref": "[EMAIL_1]", "kind": "email"}],
                    "redaction_count": 1,
                },
            }
        )
        plan = ws.receive_json()
        assert plan["type"] == "plan"

    after = client.get("/stats").json()
    assert after["plans"] == before["plans"] + 1
    assert after["providers"].get("echo", {}).get("count", 0) >= 1
