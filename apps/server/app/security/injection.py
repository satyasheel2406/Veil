import re

from ..protocol.models import ScreenContext

BLOCK = "[INJECTION_BLOCKED]"

_HIDDEN_CHARS_RE = re.compile("[\u200b\u200c\u200d\u2060\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069]")

_INJECTION_PATTERNS = [
    re.compile(r"\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|directions?)\b", re.I),
    re.compile(
        r"\b(reveal|expose|print|show|leak|output|repeat)\b[^.\n]{0,30}\b(placeholders?|refs?|values?|passwords?|secrets?|credentials?)\b",
        re.I,
    ),
    re.compile(r"\b(you are now|act as|pretend to be|behave as if)\b", re.I),
    re.compile(r"(?:^|\n)[ \t]*(system|assistant|developer)[ \t]*:", re.I),
    re.compile(r"<\|(?:im_start|im_end|endoftext)\|>|\[INST\]|\[/INST\]", re.I),
    re.compile(
        r"\b(send|upload|post|forward|email)\b[^.\n]{0,40}\b(api[ -]?keys?|clipboard|pii|credentials?|placeholders?|the refs?)\b",
        re.I,
    ),
    re.compile(
        r"\b(bypass|disable|turn off|switch off)\b[^.\n]{0,30}\b(safety|guardrails?|filters?|restrictions?|security|redaction)\b",
        re.I,
    ),
    re.compile(r"\b(new|updated) instructions?[ \t]*:", re.I),
    re.compile(r"\bimportant (?:note|message) (?:from|for) (?:the )?(?:developer|admin|system)", re.I),
]


def scrub_text(text: str) -> tuple[str, int]:
    hits = 0

    def _strip(m: re.Match[str]) -> str:
        nonlocal hits
        hits += 1
        return ""

    def _block(m: re.Match[str]) -> str:
        nonlocal hits
        hits += 1
        return BLOCK

    out = _HIDDEN_CHARS_RE.sub(_strip, text)
    for pattern in _INJECTION_PATTERNS:
        out = pattern.sub(_block, out)
    return out, hits


def sanitize_screen(screen: ScreenContext) -> tuple[ScreenContext, list[int], int]:
    flagged_ids: list[int] = []
    total_hits = 0

    elements = []
    for el in screen.elements:
        el_hits = 0
        name = el.name
        value = el.value
        if name:
            name, h = scrub_text(name)
            el_hits += h
        if value is not None and getattr(value, "text", None):
            new_text, h = scrub_text(value.text)  # type: ignore[attr-defined]
            el_hits += h
            if h:
                value = value.model_copy(update={"text": new_text})
        if el_hits:
            flagged_ids.append(el.id)
            total_hits += el_hits
            elements.append(el.model_copy(update={"name": name, "value": value}))
        else:
            elements.append(el)

    title, title_hits = scrub_text(screen.title)
    total_hits += title_hits

    if not total_hits:
        return screen, [], 0

    return (
        screen.model_copy(update={"title": title[:160], "elements": elements}),
        flagged_ids,
        total_hits,
    )
