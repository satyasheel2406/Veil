import os
import sys
from pathlib import Path

# Hermetic test environment: never let a developer's real .env select providers.
os.environ["LLM_PROVIDER"] = "echo"
os.environ.pop("LLM_MODEL", None)
os.environ.pop("LLM_API_KEY", None)
os.environ.pop("LLM_BASE_URL", None)
os.environ.pop("LLM_VISION", None)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
