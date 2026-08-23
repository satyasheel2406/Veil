from typing import Any

from ..protocol.models import TERMINAL_ACTIONS

ALLOWED_TYPES = {"click", "fill", "scroll", "navigate", "wait", "done", "fail"}


def _type_of(a: Any) -> str | None:
    if isinstance(a, dict):
        return a.get("type")
    return getattr(a, "type", None)


def _dump(a: Any) -> dict[str, Any]:
    if isinstance(a, dict):
        return a
    return a.model_dump(exclude_none=True)


def validate_actions(
    actions: list[Any], screen: Any, max_actions: int
) -> tuple[list[dict[str, Any]], list[str]]:
    known_ids = {el.id for el in screen.elements}
    known_refs = {pr.ref for pr in screen.pii_refs}
    cleaned: list[dict[str, Any]] = []
    violations: list[str] = []

    for i, raw in enumerate(actions):
        if len(cleaned) >= max_actions:
            violations.append(f"action[{i}] dropped: plan exceeds {max_actions} actions")
            break

        a = _dump(raw)
        atype = a.get("type")
        label = f"action[{i}]({atype})"

        if atype not in ALLOWED_TYPES:
            violations.append(f"{label} dropped: unknown type")
            continue

        target = a.get("target")
        ref = a.get("ref")

        if atype in ("click", "fill"):
            if not isinstance(target, int) or target not in known_ids:
                violations.append(f"{label} dropped: target {target} not on screen")
                continue
        if atype == "fill":
            if ref is not None and ref not in known_refs:
                violations.append(f"{label} dropped: ref '{ref}' unknown to this screen")
                continue
            if ref is None and not (a.get("text") or "").strip():
                violations.append(f"{label} dropped: empty fill text")
                continue
        if atype == "navigate":
            u = str(a.get("url", ""))
            if not u.lower().startswith(("http://", "https://")):
                violations.append(f"{label} dropped: non-http url")
                continue

        cleaned.append({k: v for k, v in a.items() if v is not None})

    if cleaned and not any(_type_of(x) in TERMINAL_ACTIONS for x in cleaned):
        violations.append("plan lacks terminal action; client loop continues observing")

    return cleaned, violations
