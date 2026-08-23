from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * (pct / 100.0)
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


@dataclass
class PlanStat:
    ts: float
    provider: str
    model: str
    usage_ms: float
    total_ms: float
    actions: int


@dataclass
class StatsRecorder:
    window: int = 500
    entries: deque[PlanStat] = field(init=False)
    failures: int = 0
    started_at: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        self.entries = deque(maxlen=self.window)

    def record(
        self, provider: str, model: str, usage_ms: float, total_ms: float, actions: int
    ) -> None:
        self.entries.append(
            PlanStat(
                ts=time.time(),
                provider=provider,
                model=model,
                usage_ms=round(usage_ms, 1),
                total_ms=round(total_ms, 1),
                actions=actions,
            )
        )

    def record_failure(self) -> None:
        self.failures += 1

    def summary(self) -> dict[str, Any]:
        by_provider: dict[str, list[PlanStat]] = {}
        for e in self.entries:
            by_provider.setdefault(e.provider, []).append(e)

        providers: dict[str, dict[str, Any]] = {}
        for name, items in sorted(by_provider.items()):
            totals = sorted(e.total_ms for e in items)
            usages = sorted(e.usage_ms for e in items)
            actions = [e.actions for e in items]
            providers[name] = {
                "count": len(items),
                "total_p50_ms": round(_percentile(totals, 50), 1),
                "total_p95_ms": round(_percentile(totals, 95), 1),
                "usage_p50_ms": round(_percentile(usages, 50), 1),
                "avg_actions": round(sum(actions) / len(actions), 2),
                "last_model": items[-1].model,
            }

        all_totals = sorted(e.total_ms for e in self.entries)
        return {
            "uptime_s": round(time.time() - self.started_at, 1),
            "plans": len(self.entries),
            "failures": self.failures,
            "total_p50_ms": round(_percentile(all_totals, 50), 1),
            "total_p95_ms": round(_percentile(all_totals, 95), 1),
            "providers": providers,
        }


stats = StatsRecorder()
