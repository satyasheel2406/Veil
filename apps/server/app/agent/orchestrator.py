from ..llm.base import LLMProvider
from ..protocol.models import TERMINAL_ACTIONS, ScreenContext
from ..security.action_validator import validate_actions


class Orchestrator:
    def __init__(self, provider: LLMProvider, max_actions: int = 10) -> None:
        self.provider = provider
        self.max_actions = max_actions

    async def plan(self, task: str, screen: ScreenContext) -> dict:
        result = await self.provider.plan(task, screen)
        actions, violations = validate_actions(result.actions, screen, self.max_actions)
        if not actions:
            from ..protocol.models import FailAction

            actions = [
                {
                    "type": "fail",
                    "reason": f"All proposed actions rejected: {violations[0] if violations else 'provider returned nothing'}",
                }
            ]
        thought = result.thought
        if violations:
            thought = (thought + " [validator: " + "; ".join(violations[:4]) + "]")[:2000]
        return {
            "thought": thought,
            "actions": actions,
            "model": result.model,
            "usage_ms": round(result.usage_ms, 1),
        }
