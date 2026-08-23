import asyncio
import json
import logging
import time
import uuid
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.routing import APIRouter

from ..agent.orchestrator import Orchestrator
from ..core.config import settings
from ..core.stats import stats
from ..llm.registry import get_provider
from ..protocol.models import ClientHello, PerceptionMsg

log = logging.getLogger("pv.gateway")
router = APIRouter()

ALLOWED_ORIGIN_SCHEMES = ("chrome-extension://", "moz-extension://")

WELCOME_MODEL_ECHO = "echo-heuristic"


def _origin_ok(origin: str | None) -> bool:
    if not settings.enforce_extension_origin:
        return True
    if origin is None or origin == "":
        return True
    return any(origin.startswith(s) for s in ALLOWED_ORIGIN_SCHEMES)


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    if not _origin_ok(ws.headers.get("origin")):
        await ws.close(code=4403)
        return

    await ws.accept()
    session_id = uuid.uuid4().hex[:12]
    provider = get_provider()
    orchestrator = Orchestrator(provider, max_actions=settings.max_actions_per_plan)
    hello: ClientHello | None = None

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg: dict[str, Any] = json.loads(raw)
            except ValueError:
                await _send_error(ws, "bad_json", "message is not valid JSON")
                continue

            mtype = msg.get("type")

            if mtype == "hello":
                try:
                    hello = ClientHello(**msg)
                except Exception as e:
                    await _send_error(ws, "bad_hello", str(e)[:300])
                    continue
                await ws.send_json(
                    {
                        "type": "welcome",
                        "session": hello.session,
                        "provider": provider.name,
                        "model": getattr(provider, "model", WELCOME_MODEL_ECHO),
                    }
                )
                log.info("session %s hello caps=%s", session_id, hello.caps)

            elif mtype == "perception":
                try:
                    pm = PerceptionMsg(**msg)
                except Exception as e:
                    await _send_error(ws, "bad_perception", f"schema violation: {str(e)[:400]}")
                    continue
                try:
                    t0 = time.perf_counter()
                    plan = await asyncio.wait_for(
                        orchestrator.plan(pm.task, pm.screen), timeout=settings.plan_timeout_s + 5
                    )
                    total_ms = (time.perf_counter() - t0) * 1000
                    stats.record(
                        provider=provider.name,
                        model=str(plan.get("model", "")),
                        usage_ms=float(plan.get("usage_ms", 0.0)),
                        total_ms=total_ms,
                        actions=len(plan["actions"]),
                    )
                except asyncio.TimeoutError:
                    stats.record_failure()
                    await _send_error(ws, "plan_timeout", "planner exceeded time budget")
                    continue
                except Exception as e:
                    stats.record_failure()
                    log.exception("planner failure")
                    await _send_error(ws, "plan_error", str(e)[:300])
                    continue
                plan_frame = {"type": "plan", "seq": pm.seq, **plan}
                await ws.send_json(plan_frame)
                log.info(
                    "session %s seq=%d plan actions=%d model=%s %.0fms",
                    session_id,
                    pm.seq,
                    len(plan["actions"]),
                    plan.get("model"),
                    plan.get("usage_ms", 0),
                )

            elif mtype == "action_result":
                log.debug("session %s action_result seq=%s n=%d", session_id, msg.get("seq"), len(msg.get("results", [])))

            else:
                await _send_error(ws, "unknown_type", f"unrecognized message type '{mtype}'")

    except WebSocketDisconnect:
        log.info("session %s disconnected", session_id)
    except Exception:
        log.exception("session %s crashed", session_id)


async def _send_error(ws: WebSocket, code: str, message: str) -> None:
    await ws.send_json({"type": "error", "code": code, "message": message})
