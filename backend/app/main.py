"""drawn API: same-origin auth, durable agent operations and verified model inference."""
from contextlib import asynccontextmanager
import logging
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from .settings import Settings
from .database import create_database
from .store import Store
from .core.errors import ApiError
from . import performance
from .routers import router

logger = logging.getLogger(__name__)

def create_app(settings=None):
    settings = settings or Settings()
    @asynccontextmanager
    async def lifespan(app):
        engine, factory = create_database(settings.database_url)
        app.state.engine = engine
        app.state.session_factory = factory
        app.state.store = Store(factory)
        await app.state.store.expire_runs()
        performance.initialize(settings)
        app.state.performance = lambda design_id, draft=None, speeds=None: performance.predict_design(settings, design_id, draft, speeds)
        try:
            yield
        finally:
            await engine.dispose()
    app = FastAPI(title="drawn API", version="2.0.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    app.state.settings = settings
    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError):
        return JSONResponse({"error":error.message,"code":error.code}, status_code=error.status, headers={"Cache-Control":"no-store"})
    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error):
        return JSONResponse({"error":"입력값을 확인해 주세요.","code":"invalid_input"}, status_code=422)
    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error):
        logger.exception("Unhandled API error on %s", request.url.path)
        return JSONResponse({"error":"요청을 처리하지 못했습니다.","code":"internal_error"}, status_code=500)
    @app.get("/api/health/live")
    async def live():
        return {"status":"ok"}
    @app.get("/api/health/ready")
    async def ready(request: Request):
        async with request.app.state.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        model = performance.status()
        return JSONResponse({"database":"ready","model":model}, status_code=200 if model["ready"] else 503)
    app.include_router(router, prefix="/api")
    app.include_router(performance.router, prefix="/api")
    return app

app = create_app()
