import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .core.config import settings
from .core.stats import stats
from .gateway.ws import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

def _find_repo_root() -> Path | None:
    # Works both in the repo (apps/server/app/main.py) and in the container
    # (/srv/app/main.py) — locate by marker instead of fixed depth.
    for parent in Path(__file__).resolve().parents:
        if (parent / "demo").is_dir():
            return parent
    return None


REPO_ROOT = _find_repo_root()
DEMO_DIR = REPO_ROOT / "demo" if REPO_ROOT else None


def create_app() -> FastAPI:
    app = FastAPI(title="PV Agent Server", version="0.1.0")
    app.include_router(ws_router)

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "provider": settings.llm_provider}

    @app.get("/stats")
    async def stats_endpoint() -> dict:
        return {"ok": True, **stats.summary()}

    if DEMO_DIR is not None and DEMO_DIR.exists():
        app.mount("/demo", StaticFiles(directory=str(DEMO_DIR), html=True), name="demo")

    return app


app = create_app()
