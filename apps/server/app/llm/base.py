from typing import Protocol

from ..protocol.models import AgentAction, ScreenContext


class PlanResult:
    def __init__(
        self,
        thought: str,
        actions: list[AgentAction],
        model: str,
        usage_ms: float,
    ) -> None:
        self.thought = thought
        self.actions = actions
        self.model = model
        self.usage_ms = usage_ms


class LLMProvider(Protocol):
    name: str

    async def plan(self, task: str, screen: ScreenContext) -> PlanResult:
        ...

    def describe(self) -> str:
        ...
