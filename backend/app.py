"""
ContentCore Backend - FastAPI Application

Provides the POST /define API endpoint for the PDF & E-book Reader Extension.
Enforces strict input validation, privacy safeguards, and standardized error envelopes.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.config import settings, SUPPORTED_PROVIDERS
from backend.exceptions import (
    ContentCoreException,
    InvalidInputException,
)
from backend.schemas import (
    CredentialRegisterRequest,
    CredentialRegisterResponse,
    DefineRequest,
    DefineResponse,
    ErrorResponse,
)
from backend.services.credential_service import credential_service
from backend.services.llm_service import llm_service

# Configure privacy-preserving logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("contentcore.api")


def require_backend_auth(request: Request) -> None:
    """Enforces optional backend authentication without treating it as an LLM key."""
    expected_token = settings.backend_auth_token
    if not expected_token:
        return

    provided_token = request.headers.get("x-api-key") or ""
    authorization = request.headers.get("authorization") or ""
    if not provided_token and authorization.lower().startswith("bearer "):
        provided_token = authorization[7:].strip()
    if provided_token != expected_token:
        raise InvalidInputException("A valid backend API key is required.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle handler."""
    await run_in_threadpool(credential_service.initialize)
    logger.info(
        f"Starting ContentCore backend (Provider: {settings.provider_name}, Model: {settings.model}, Configured: {settings.is_configured})"
    )
    try:
        yield
    finally:
        credential_service.engine.dispose()
        logger.info("ContentCore backend shut down.")


app = FastAPI(
    title="ContentCore Smart PDF & E-Book Reader API",
    description="Context-aware definition engine for selected document text.",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for browser extension contexts (including chrome-extension:// origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Exception Handlers
# ---------------------------------------------------------------------------
@app.exception_handler(ContentCoreException)
async def handle_contentcore_exception(
    request: Request, exc: ContentCoreException
) -> JSONResponse:
    """Handles domain-specific ContentCore exceptions."""
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "status": "error",
            "code": exc.code,
            "message": exc.message,
        },
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Handles FastAPI/Pydantic request validation failures."""
    return JSONResponse(
        status_code=400,
        content={
            "status": "error",
            "code": "INVALID_INPUT",
            "message": "Selected text and its surrounding passage are required.",
        },
    )


@app.exception_handler(StarletteHTTPException)
async def handle_starlette_http_exception(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """Catches HTTP exceptions such as 400 Bad Request on JSON decoding."""
    if exc.status_code == 400:
        return JSONResponse(
            status_code=400,
            content={
                "status": "error",
                "code": "INVALID_INPUT",
                "message": "Selected text and its surrounding passage are required.",
            },
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "status": "error",
            "code": "HTTP_ERROR",
            "message": exc.detail,
        },
    )


@app.exception_handler(Exception)
async def handle_generic_exception(
    request: Request, exc: Exception
) -> JSONResponse:
    """
    Fallback exception handler.
    Ensures internal stack traces and server details are never exposed to clients.
    """
    logger.error(f"Unhandled server error: {type(exc).__name__}")
    return JSONResponse(
        status_code=503,
        content={
            "status": "error",
            "code": "DEFINITION_UNAVAILABLE",
            "message": "The definition service is temporarily unavailable. Please try again.",
        },
    )


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------
@app.post(
    "/define",
    response_model=DefineResponse,
    responses={
        400: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
        504: {"model": ErrorResponse},
    },
)
async def define_text(request: Request) -> JSONResponse:
    """
    Context-aware definition endpoint.
    
    Accepts target text (under 'word', 'phrase', 'target', or 'selectedText')
    and surrounding 'context'. Returns an instant, simplified contextual explanation.
    """
    require_backend_auth(request)
    try:
        payload = await request.json()
    except Exception:
        raise InvalidInputException(
            "Selected text and its surrounding passage are required."
        )

    # Validate and normalize payload
    req = DefineRequest.model_validate(payload)

    # Resolve a registered BYOK credential on the backend. Direct fields remain
    # available for non-extension clients, but the extension only sends references.
    credential_config = None
    if req.credential_id or req.credential_token:
        credential_config = await run_in_threadpool(
            credential_service.resolve,
            credential_id=req.credential_id or "",
            credential_token=req.credential_token or "",
        )

    direct_api_key = credential_config["api_key"] if credential_config else req.api_key
    direct_provider = credential_config["provider"] if credential_config else req.provider
    direct_model = credential_config["model"] if credential_config else req.model
    direct_base_url = credential_config["base_url"] if credential_config else req.base_url

    # Call LLM contextual engine
    result: DefineResponse = await run_in_threadpool(
        llm_service.define,
        target=req.target,
        context=req.context,
        api_key=direct_api_key,
        provider=direct_provider,
        model=direct_model,
        base_url=direct_base_url,
    )

    return JSONResponse(
        status_code=200,
        content=result.model_dump(),
    )


@app.post(
    "/credentials",
    response_model=CredentialRegisterResponse,
    responses={400: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)
async def register_credential(request: Request) -> CredentialRegisterResponse:
    """Encrypt and register a user's provider key without returning the key."""
    require_backend_auth(request)
    try:
        payload = await request.json()
        req = CredentialRegisterRequest.model_validate(payload)
    except Exception as error:
        if isinstance(error, InvalidInputException):
            raise
        raise InvalidInputException(
            "Provider, API key, and optional model are required."
        ) from error

    registered = await run_in_threadpool(
        credential_service.register,
        provider=req.provider,
        api_key=req.api_key,
        model=req.model,
        base_url=req.base_url,
    )
    return CredentialRegisterResponse(**registered)


@app.delete(
    "/credentials/{credential_id}",
    responses={400: {"model": ErrorResponse}},
)
async def delete_credential(credential_id: str, request: Request) -> dict[str, str]:
    """Delete a registered credential using its opaque access token."""
    require_backend_auth(request)
    token = request.headers.get("x-credential-token") or ""
    auth_header = request.headers.get("authorization") or ""
    if not token and auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
    await run_in_threadpool(credential_service.delete, credential_id, token)
    return {"status": "deleted"}


@app.get("/health")
async def health_check() -> dict[str, Any]:
    """Health check endpoint providing non-sensitive operational status."""
    return {
        "status": "healthy",
        "provider": settings.provider_name,
        "model": settings.model,
        "configured": settings.is_configured,
        "supported_providers": SUPPORTED_PROVIDERS,
        "credential_storage_configured": credential_service.encryption_configured,
        "credential_storage_backend": credential_service.storage_backend,
        "accepts_credential_references": True,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
