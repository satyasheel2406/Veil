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


def _detect_page_type(screen: ScreenContext) -> str:
    """Ordered classification: confirmation > transfer_form > dashboard > form > unknown."""
    headings = [el for el in screen.elements if el.role == "heading"]
    heading_text = " ".join(_name_of(h) for h in headings).lower()
    title = screen.title.lower()
    combined = f"{heading_text} {title} {screen.url_skeleton.lower()}"
    editables = [el for el in screen.elements if el.editable]

    # 1. Explicit completion pages — strongest signal first.
    if any(w in combined for w in ("confirmation", "confirmed", "success", "completed", "receipt", "transaction status")):
        return "confirmation"

    # 2. Transfer/fund forms require BOTH a form keyword AND real input fields;
    #    dashboards often mention "transfer money" as a quick-action tile.
    if any(w in combined for w in ("transfer", "fund transfer", "send money", "payment")) and len(editables) >= 2:
        return "transfer_form"

    # 3. Dashboard / landing pages of an authenticated app.
    if any(w in combined for w in ("dashboard", "welcome", "overview", "account summary")):
        return "dashboard"

    # 4. Generic form page.
    if len(editables) >= 2:
        return "form"

    return "unknown"


_AMOUNT_RE = re.compile(r"(?:rs\.?|₹|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:k\b)?", re.I)


def _task_amount(task: str) -> str | None:
    """Extract a monetary amount mentioned in the task, e.g. 'send 500 to Ravi'."""
    m = _AMOUNT_RE.search(task)
    if not m:
        return None
    digits = m.group(1).replace(",", "")
    try:
        val = float(digits)
    except ValueError:
        return None
    if m.group(0).strip().lower().endswith("k"):
        val *= 1000
    if val <= 0:
        return None
    return str(int(val)) if val == int(val) else str(val)


class EchoProvider:
    name = "echo"

    async def plan(
        self,
        task: str,
        screen: ScreenContext,
        history=None,
        on_delta=None,
    ) -> PlanResult:
        t0 = time.perf_counter()
        actions: list[AgentAction] = []
        details: list[dict] = []
        notes: list[str] = []

        elements = list(screen.elements)
        used_targets: set[int] = set()
        page_type = _detect_page_type(screen)

        # Multi-turn memory: never re-fill a field we already filled this session.
        filled_before = {
            d.get("target")
            for h in (history or [])
            for d in h.get("details", [])
            if isinstance(d, dict) and d.get("t") == "fill"
        }

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
            or "transfer" in task_ns
            or "send" in task_ns
            or "sendmoney" in task_ns
        )

        def finish(thought_prefix: str) -> PlanResult:
            thought = f"[echo/heuristic] page_type={page_type}, task='{task}'. " + thought_prefix
            usage_ms = (time.perf_counter() - t0) * 1000
            return PlanResult(
                thought=thought[:2000],
                actions=actions,
                model=self.describe(),
                usage_ms=usage_ms,
                details=details,
            )

        # --- Confirmation pages: report completion -----------------------------
        if page_type == "confirmation":
            summary_parts = [el.name for el in elements if el.role == "heading" and el.name]
            summary = "Confirmed: " + "; ".join(summary_parts[:3]) if summary_parts else "Transaction confirmed."
            actions.append(DoneAction(type="done", summary=summary[:480]))
            return finish("Confirmation page detected, reporting completion.")

        # --- Dashboard: navigate toward the requested section (NO done —
        #     the flow continues on the next page in the next turn) -------------
        if page_type == "dashboard":
            nav_target = None
            for el in elements:
                name_l = _name_of(el)
                if el.role in ("button", "link") and name_l:
                    if any(w in task_l for w in ("transfer", "send")) and any(
                        w in name_l for w in ("transfer", "send")
                    ):
                        nav_target = el
                        break
                    if "statement" in task_l and "statement" in name_l:
                        nav_target = el
                        break
                    if "setting" in task_l and "setting" in name_l:
                        nav_target = el
                        break

            if nav_target:
                actions.append(ClickAction(type="click", target=nav_target.id))
                details.append({"t": "click", "target": nav_target.id})
                notes.append(f"navigating to '{nav_target.name}' from dashboard; waiting for next page")
                return finish(" ".join(notes))

            interactive = [el for el in elements if el.role in ("button", "link") and el.name]
            if interactive and not filled_before:
                actions.append(ClickAction(type="click", target=interactive[0].id))
                details.append({"t": "click", "target": interactive[0].id})
                notes.append(f"no specific match on dashboard; probing '{interactive[0].name}'")
                return finish(" ".join(notes))

            actions.append(DoneAction(type="done", summary="Dashboard explored; nothing more to do."))
            return finish("no navigation target found")

        # --- Transfer form: map refs, fill amount literal, submit (NO done —
        #     the confirmation page arrives next turn) ---------------------------
        if page_type == "transfer_form":
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
                        and el.id not in filled_before
                        and _name_of(el)
                        and any(k in _name_of(el) for k in keywords)
                    ),
                    None,
                )
                if candidate is not None:
                    actions.append(FillAction(type="fill", target=candidate.id, ref=pr.ref))
                    used_targets.add(candidate.id)
                    details.append({"t": "fill", "target": candidate.id, "kind": pr.kind})
                    notes.append(f"mapped {pr.kind} -> element {candidate.id} ('{candidate.name}')")

            amount = _task_amount(task)
            if amount:
                amount_field = next(
                    (
                        el
                        for el in elements
                        if el.id in empty_by_id
                        and el.id not in used_targets
                        and el.id not in filled_before
                        and any(w in _name_of(el) for w in ("amount", "amt", "rupee", "sum", "value"))
                    ),
                    None,
                )
                if amount_field is not None:
                    actions.append(FillAction(type="fill", target=amount_field.id, text=amount))
                    used_targets.add(amount_field.id)
                    details.append({"t": "fill", "target": amount_field.id, "kind": "amount"})
                    notes.append(f"filled amount '{amount}' -> element {amount_field.id}")

            submit_btn = next(
                (
                    el
                    for el in elements
                    if el.role == "button" and el.name and SUBMIT_RE.search(el.name)
                ),
                None,
            )
            if submit_btn is not None and len(actions) > 0:
                actions.append(ClickAction(type="click", target=submit_btn.id))
                details.append({"t": "click", "target": submit_btn.id})
                notes.append(f"click submit-like button '{submit_btn.name}' (awaiting confirmation page)")

            if not actions:
                actions.append(DoneAction(type="done", summary="No transfer fields found to act on."))
            elif not any(a.type in ("done", "fail") for a in actions):
                pass  # multi-page: let the next turn observe the result page
            return finish(" ".join(notes) if notes else "no PII-to-field matches found.")

        # --- Generic form (login/signup/etc.): fill + submit + done ------------
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
                    and el.id not in filled_before
                    and _name_of(el)
                    and any(k in _name_of(el) for k in keywords)
                ),
                None,
            )
            if candidate is not None:
                actions.append(FillAction(type="fill", target=candidate.id, ref=pr.ref))
                used_targets.add(candidate.id)
                details.append({"t": "fill", "target": candidate.id, "kind": pr.kind})
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
            details.append({"t": "click", "target": submit_btn.id})
            notes.append(f"click submit-like button '{submit_btn.name}'")

        if not actions:
            interactive = [el for el in elements if el.role != "heading"]
            if interactive:
                actions.append(ClickAction(type="click", target=interactive[0].id))
                details.append({"t": "click", "target": interactive[0].id})
                notes.append(f"no strong match; probing first interactive element '{interactive[0].name}'")
            else:
                actions.append(DoneAction(type="done", summary="No actionable elements on screen."))

        if not any(a.type in ("done", "fail") for a in actions):
            summary = f"Executed {len(actions)} step(s): " + "; ".join(notes[:3])
            actions.append(DoneAction(type="done", summary=summary[:480]))

        return finish(" ".join(notes) if notes else "no PII-to-field matches found.")

    def describe(self) -> str:
        return "echo-heuristic"
