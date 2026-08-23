import json
import time
from typing import Any

import httpx

from ..protocol.models import AgentAction, ScreenContext
from .base import PlanResult

SYSTEM_PROMPT = """You are the reasoning core of a browser automation agent.
The client browser sends you an ANONYMIZED description of the current web page:
- `elements`: interactive/semantic elements, each with a stable numeric `id`, its `role`,
  accessible `name`, and `value` (sensitive values are replaced by placeholder refs like [EMAIL_1]).
- `pii_refs`: the set of placeholder refs available for this screen (kind + ref). Values never leave the user's machine.

Your job: decide the next best sequence of actions to accomplish the user's task.

Respond with STRICT JSON only (no markdown, no prose) matching:
{
  "thought": "short reasoning",
  "actions": [
    {"type":"click","target":<element id>},
    {"type":"fill","target":<element id>,"ref":"[EMAIL_1]"} ,
    {"type":"fill","target":<element id>,"text":"literal text when no ref fits"},
    {"type":"scroll","direction":"down","amount":600},
    {"type":"navigate","url":"https://..."},
    {"type":"wait","ms":500},
    {"type":"done","summary":"what was accomplished"},
    {"type":"fail","reason":"why the task cannot proceed"}
  ]
}

Rules:
- Only reference element ids present in `elements`.
- For sensitive data always use refs from `pii_refs`; NEVER invent or ask for raw values.
- Prefer fewest actions that make progress; emit "done" when finished, "fail" if blocked.
- Maximum 10 actions per response."""


class ProviderError(RuntimeError):
    pass


class OpenAICompatProvider:
    def __init__(self, name: str, base_url: str, model: str, api_key: str, timeout_s: float = 20.0):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout_s = timeout_s

    async def plan(self, task: str, screen: ScreenContext) -> PlanResult:
        payload: dict[str, Any] = {
            "model": self.model,
            "temperature": 0.0,
            "max_tokens": 1024,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"task": task, "screen": screen.model_dump(mode="json")},
                        separators=(",", ":"),
                    ),
                },
            ],
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(f"{self.base_url}/chat/completions", json=payload, headers=headers)
                resp.raise_for_status()
                body = resp.json()
        except httpx.HTTPStatusError as e:
            raise ProviderError(f"{self.name} HTTP {e.response.status_code}: {e.response.text[:300]}") from e
        except (httpx.HTTPError, ValueError) as e:
            raise ProviderError(f"{self.name} request failed: {e}") from e

        usage_ms = (time.perf_counter() - t0) * 1000
        content = body.get("choices", [{}])[0].get("message", {}).get("content", "")
        try:
            parsed = json.loads(content)
            thought = str(parsed.get("thought", ""))[:2000]
            raw_actions = parsed.get("actions", [])
            actions: list[AgentAction] = []
            for a in raw_actions[:10]:
                if isinstance(a, dict) and "type" in a:
                    actions.append(a)
            return _typed_plan(thought, actions, self.describe(), usage_ms)
        except (ValueError, TypeError) as e:
            raise ProviderError(f"{self.name} returned malformed plan JSON: {e}") from e

    def describe(self) -> str:
        return f"{self.name}:{self.model}"


def _typed_plan(
    thought: str, raw_actions: list[Any], model: str, usage_ms: float
) -> PlanResult:
    from ..protocol.models import (
        ClickAction,
        DoneAction,
        FailAction,
        FillAction,
        NavigateAction,
        ScrollAction,
        WaitAction,
    )

    mapping = {
        "click": ClickAction,
        "fill": FillAction,
        "scroll": ScrollAction,
        "navigate": NavigateAction,
        "wait": WaitAction,
        "done": DoneAction,
        "fail": FailAction,
    }
    typed: list[AgentAction] = []
    for ra in raw_actions:
        cls = mapping.get(ra.get("type"))
        if cls is None:
            continue
        try:
            typed.append(cls(**ra))
        except Exception:
            continue
    return PlanResult(thought=thought, actions=typed, model=model, usage_ms=usage_ms)
