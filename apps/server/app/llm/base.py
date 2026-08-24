from typing import Awaitable, Callable, Optional, Protocol

from ..protocol.models import AgentAction, ScreenContext


class PlanResult:
    def __init__(
        self,
        thought: str,
        actions: list[AgentAction],
        model: str,
        usage_ms: float,
        details: Optional[list[dict]] = None,
    ) -> None:
        self.thought = thought
        self.actions = actions
        self.model = model
        self.usage_ms = usage_ms
        self.details = details or []


# Compact per-turn memory entry appended by the orchestrator.
HistoryEntry = dict

DeltaCallback = Callable[[str], Awaitable[None]]


class LLMProvider(Protocol):
    name: str

    async def plan(
        self,
        task: str,
        screen: ScreenContext,
        history: Optional[list[HistoryEntry]] = None,
        on_delta: Optional[DeltaCallback] = None,
    ) -> PlanResult:
        ...

    def describe(self) -> str:
        ...
