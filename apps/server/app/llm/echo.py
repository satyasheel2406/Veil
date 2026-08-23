import re
import time

from ..protocol.models import (
    AgentAction,
    ClickAction,
    DoneAction,
    ElementNode,
    FillAction,
    ScreenContext,
)
from .base import PlanResult
from .task_keywords import KIND_KEYWORDS, SUBMIT_RE


def _name_of(el: ElementNode) -> str:
    return (el.name or "").lower()


class EchoProvider:
    name = "echo"

    async def plan(self, task: str, screen: ScreenContext) -> PlanResult:
        t0 = time.perf_counter()
        actions: list[AgentAction] = []
        notes: list[str] = []

        elements = list(screen.elements)
        used_targets: set[int] = set()

        empty_by_id = {el.id for el in elements if el.editable and el.value is None}
        task_l = task.lower()
        task_ns = re.sub(r"[^a-z0-9]", "", task_l)
        formish = (
            "form" in task_l
            or "login" in task_ns
            or "signin" in task_ns
            or "signup" in task_ns
            or "register" in task_ns
            or "checkout" in task_ns
            or "payment" in task_ns
        )

        for pr in screen.pii_refs:
            keywords = KIND_KEYWORDS.get(pr.kind)
            if not keywords:
                continue
            mentioned = any(k.replace(" ", "").replace("-", "") in task_ns for k in keywords)
            if not (mentioned or formish):
                continue
            candidate = next(
                (
                    el
                    for el in elements
                    if el.id in empty_by_id
                    and el.id not in used_targets
                    and _name_of(el)
                    and any(k in _name_of(el) for k in keywords)
                ),
                None,
            )
            if candidate is not None:
                actions.append(FillAction(type="fill", target=candidate.id, ref=pr.ref))
                used_targets.add(candidate.id)
                notes.append(f"mapped {pr.kind} -> element {candidate.id} ('{candidate.name}')")

        submit_btn = next(
            (
                el
                for el in elements
                if el.role == "button" and el.name and SUBMIT_RE.search(el.name)
            ),
            None,
        )
        if submit_btn is not None:
            actions.append(ClickAction(type="click", target=submit_btn.id))
            notes.append(f"click submit-like button '{submit_btn.name}'")

        if not actions:
            interactive = [el for el in elements if el.role != "heading"]
            if interactive:
                actions.append(
                    ClickAction(type="click", target=interactive[0].id)
                )
                notes.append(f"no strong match; probing first interactive element '{interactive[0].name}'")
            else:
                actions.append(DoneAction(type="done", summary="No actionable elements on screen."))

        if not any(a.type in ("done", "fail") for a in actions):
            summary = f"Executed {len(actions)} step(s): " + "; ".join(notes[:3])
            actions.append(DoneAction(type="done", summary=summary[:480]))

        thought = (
            f"[echo/heuristic] task='{task}'. "
            + (" ".join(notes) if notes else "no PII-to-field matches found.")
        )
        usage_ms = (time.perf_counter() - t0) * 1000
        return PlanResult(thought=thought[:2000], actions=actions, model=self.describe(), usage_ms=usage_ms)

    def describe(self) -> str:
        return "echo-heuristic"
