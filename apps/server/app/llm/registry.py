from ..core.config import PROVIDER_PRESETS, settings
from .base import LLMProvider
from .echo import EchoProvider


def get_provider() -> LLMProvider:
    name = settings.llm_provider.lower()
    if name in ("", "echo"):
        return EchoProvider()
    if name not in PROVIDER_PRESETS:
        raise ValueError(f"Unknown LLM_PROVIDER '{name}'. Options: echo, {', '.join(PROVIDER_PRESETS)}")
    from .openai_compat import OpenAICompatProvider

    preset = PROVIDER_PRESETS[name]
    return OpenAICompatProvider(
        name=name,
        base_url=settings.llm_base_url or preset["base_url"],
        model=settings.llm_model or preset["model"],
        api_key=settings.llm_api_key,
        timeout_s=settings.plan_timeout_s,
    )
