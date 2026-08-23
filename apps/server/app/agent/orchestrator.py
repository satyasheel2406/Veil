from ..llm.base import LLMProvider
from ..protocol.models import TERMINAL_ACTIONS, ScreenContext
from ..security.action_validator import validate_actions
from ..security.injection import sanitize_screen


class Orchestrator:
    def __init__(self, provider: LLMProvider, max_actions: int = 10) -> None:
        self.provider = provider
        self.max_actions = max_actions

    async def plan(self, task: str, screen: ScreenContext) -> dict:
        screen_llm, _flagged, injection_hits = sanitize_screen(screen)
        result = await self.provider.plan(task, screen_llm)
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
        if injection_hits:
            thought = (
                thought + f" [guard: neutralized {injection_hits} prompt-injection pattern(s) in page content]"
            )[:2000]
        return {
            "thought": thought,
            "actions": actions,
            "model": result.model,
            "usage_ms": round(result.usage_ms, 1),
        }
