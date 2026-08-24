from typing import Optional

from ..llm.base import DeltaCallback, LLMProvider
from ..protocol.models import TERMINAL_ACTIONS, ScreenContext
from ..security.action_validator import validate_actions
from ..security.injection import sanitize_screen


class Orchestrator:
    def __init__(self, provider: LLMProvider, max_actions: int = 10, max_history: int = 6) -> None:
        self.provider = provider
        self.max_actions = max_actions
        self.max_history = max_history
        self.history: list[dict] = []  # compact per-turn memory for multi-page flows

    async def plan(
        self,
        task: str,
        screen: ScreenContext,
        on_delta: Optional[DeltaCallback] = None,
        first_turn: bool = False,
    ) -> dict:
        if first_turn:
            self.history.clear()
        screen_llm, _flagged, injection_hits = sanitize_screen(screen)
        result = await self.provider.plan(task, screen_llm, history=self.history, on_delta=on_delta)
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
        
        plan_result = {
            "thought": thought,
            "actions": actions,
            "model": result.model,
            "usage_ms": round(result.usage_ms, 1),
        }
        
        # Record this step in history for multi-turn context
        self.history.append({
            "turn": len(self.history) + 1,
            "page_title": screen.title,
            "url": screen.url_skeleton,
            "element_count": len(screen.elements),
            "thought": thought[:200],
            "actions_taken": [a.get("type", "unknown") if isinstance(a, dict) else getattr(a, "type", "unknown") for a in actions[:5]],
            "details": list(getattr(result, "details", []) or [])[:10],
        })
        if len(self.history) > self.max_history:
            self.history.pop(0)

        return plan_result
    
    def clear_history(self) -> None:
        self.history.clear()
