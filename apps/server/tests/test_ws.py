import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.gateway.ws import router  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


MINI_SCREEN = {
    "url_skeleton": "https://demo.bank.example/**",
    "title": "Nebula Bank - Sign in",
    "viewport": {"w": 1280, "h": 800},
    "scroll": {"x": 0, "y": 0},
    "frame_hash": "abc123",
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
            "rect": {"x": 100, "y": 250, "w": 300, "h": 32},
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
            "rect": {"x": 100, "y": 300, "w": 120, "h": 40},
            "in_viewport": True,
            "attributes": {},
        },
    ],
    "pii_refs": [
        {"ref": "[EMAIL_1]", "kind": "email"},
        {"ref": "[PASSWORD_1]", "kind": "password"},
    ],
    "redaction_count": 2,
}

TIMINGS = {"extract_ms": 5, "redact_ms": 3, "serialize_ms": 1, "rtt_ms": None}


def _perception(seq=1, task="Log in to my account", screen=None):
    return {
        "type": "perception",
        "seq": seq,
        "task": task,
        "screen": screen or MINI_SCREEN,
        "timings": TIMINGS,
    }


def test_hello_welcome_roundtrip(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "v": 1, "session": "session-1234", "caps": {"webgpu": False, "dpr": 1}})
        resp = ws.receive_json()
        assert resp["type"] == "welcome"
        assert resp["provider"] == "echo"


def test_perception_returns_valid_plan(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "v": 1, "session": "session-1234", "caps": {}})
        ws.receive_json()
        ws.send_json(_perception())
        plan = ws.receive_json()
        assert plan["type"] == "plan"
        assert plan["seq"] == 1
        types = [a["type"] for a in plan["actions"]]
        assert "fill" in types
        assert types[-1] == "done"
        fill_actions = [a for a in plan["actions"] if a["type"] == "fill"]
        assert all(a["ref"] in {p["ref"] for p in MINI_SCREEN["pii_refs"]} for a in fill_actions)


def test_validator_rejects_unknown_target(client):
    bad_screen = json.loads(json.dumps(MINI_SCREEN))
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "v": 1, "session": "session-1234", "caps": {}})
        ws.receive_json()
        msg = _perception(screen=bad_screen)
        msg["task"] = ""
        ws.send_json(msg)
        plan = ws.receive_json()
        assert plan["type"] == "plan"
        for a in plan["actions"]:
            if a["type"] in ("click", "fill"):
                assert a["target"] in {0, 1, 2}


def test_invalid_message_gets_error_frame(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "v": 1, "session": "session-1234", "caps": {}})
        ws.receive_json()
        ws.send_text("this is not json")
        err = ws.receive_json()
        assert err["type"] == "error"
        assert err["code"] == "bad_json"

        ws.send_json({"type": "wat"})
        err = ws.receive_json()
        assert err["code"] == "unknown_type"


def test_bad_perception_schema_rejected(client):
    broken = _perception()
    del broken["screen"]["viewport"]
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "v": 1, "session": "session-1234", "caps": {}})
        ws.receive_json()
        ws.send_json(broken)
        err = ws.receive_json()
        assert err["type"] == "error"
        assert err["code"] == "bad_perception"
