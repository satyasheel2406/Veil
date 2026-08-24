from dataclasses import dataclass
import os

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    llm_provider: str = os.getenv("LLM_PROVIDER", "echo")
    llm_model: str = os.getenv("LLM_MODEL", "")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "")
    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_vision: bool = os.getenv("LLM_VISION", "true").lower() != "false"
    plan_timeout_s: float = float(os.getenv("PLAN_TIMEOUT_S", "25"))
    max_actions_per_plan: int = int(os.getenv("MAX_ACTIONS_PER_PLAN", "10"))
    max_elements: int = int(os.getenv("MAX_ELEMENTS", "400"))
    enforce_extension_origin: bool = os.getenv("ENFORCE_EXTENSION_ORIGIN", "false").lower() == "true"
    # Optional shared-secret gate for /ws. Empty string disables the check (dev mode).
    ws_auth_token: str = os.getenv("WS_AUTH_TOKEN", "")
    rate_limit_msgs: int = int(os.getenv("RATE_LIMIT_MSGS", "60"))
    rate_limit_window_s: float = float(os.getenv("RATE_LIMIT_WINDOW_S", "10"))


settings = Settings()

PROVIDER_PRESETS: dict[str, dict[str, str]] = {
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "model": "openai/gpt-oss-120b",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "model": "qwen/qwen2.5-vl-72b-instruct",
    },
    "vllm": {
        "base_url": settings.llm_base_url or "http://localhost:8000/v1",
        "model": "qwen2.5-vl-7b-instruct",
    },
}
