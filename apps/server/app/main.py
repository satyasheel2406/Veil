import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .core.config import settings
from .core.stats import stats
from .gateway.ws import router as ws_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

REPO_ROOT = Path(__file__).resolve().parents[3]
DEMO_DIR = REPO_ROOT / "demo"


def create_app() -> FastAPI:
    app = FastAPI(title="PV Agent Server", version="0.1.0")
    app.include_router(ws_router)

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "provider": settings.llm_provider}

    @app.get("/stats")
    async def stats_endpoint() -> dict:
        return {"ok": True, **stats.summary()}

    if DEMO_DIR.exists():
        app.mount("/demo", StaticFiles(directory=str(DEMO_DIR), html=True), name="demo")

    return app


app = create_app()
