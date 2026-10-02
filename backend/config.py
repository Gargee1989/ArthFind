"""
ContentCore Backend Configuration

    Loads environment variables, defines operational thresholds, and configures
    the LLM provider (Gemini, NVIDIA NIM, or OpenAI) without exposing credentials.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from dotenv import load_dotenv

# Directory paths
BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent
ENV_FILE_PATH = BACKEND_DIR / ".env"
FALLBACK_ENV_PATH = ROOT_DIR / ".env"

# Explicitly load environment variables
if ENV_FILE_PATH.exists():
    load_dotenv(dotenv_path=ENV_FILE_PATH)
elif FALLBACK_ENV_PATH.exists():
    load_dotenv(dotenv_path=FALLBACK_ENV_PATH)
else:
    load_dotenv()

# Placeholder markers
PLACEHOLDERS = {
    "your_gemini_api_key_here",
    "your_openai_api_key_here",
    "your_nvidia_api_key_here",
    "nvapi-yourActualKeyHere",
    "sk-proj-yourActualKeyHere",
}

# The 3 supported LLM API providers from docs/STEP.md
PROVIDER_GEMINI = "Google Gemini"
PROVIDER_OPENAI = "OpenAI"
PROVIDER_NVIDIA = "NVIDIA NIM"

SUPPORTED_PROVIDERS = [
    PROVIDER_GEMINI,
    PROVIDER_OPENAI,
    PROVIDER_NVIDIA,
]

DEFAULT_MODELS = {
    PROVIDER_GEMINI: "gemini-3.6-flash",
    PROVIDER_OPENAI: "gpt-4o-mini",
    PROVIDER_NVIDIA: "meta/llama-3.2-11b-vision-instruct",
}

DEFAULT_BASE_URLS = {
    PROVIDER_GEMINI: "https://generativelanguage.googleapis.com/v1beta/openai/",
    PROVIDER_OPENAI: None,
    PROVIDER_NVIDIA: "https://integrate.api.nvidia.com/v1",
}


def normalize_provider_name(provider: str | None) -> str | None:
    """Normalizes various user-input provider aliases to canonical names."""
    if not provider:
        return None
    p = provider.strip().lower().replace("_", " ").replace("-", " ")
    if "gemini" in p or "google" in p:
        return PROVIDER_GEMINI
    if "nvidia" in p or "nim" in p:
        return PROVIDER_NVIDIA
    if "openai" in p:
        return PROVIDER_OPENAI
    return provider.strip()


def detect_provider(api_key: str | None, explicit_provider: str | None = None) -> str:
    """
    Determines provider from explicit provider input, API key format, or settings fallback.
    """
    normalized = normalize_provider_name(explicit_provider)
    if normalized in SUPPORTED_PROVIDERS:
        return normalized

    if api_key:
        key = api_key.strip()
        if key.startswith("nvapi-"):
            return PROVIDER_NVIDIA
        if key.startswith("AIza"):
            return PROVIDER_GEMINI
        if key.startswith("sk-"):
            return PROVIDER_OPENAI

    return settings.provider_name


def resolve_llm_config(
    api_key: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
) -> dict[str, Any]:
    """
    Resolves configuration for direct API calls using input parameters,
    falling back to settings/.env when parameters are omitted.
    """
    has_input_key = bool(api_key and api_key.strip())
    resolved_key = api_key.strip() if has_input_key else settings.api_key
    resolved_provider = detect_provider(resolved_key, explicit_provider=provider)

    # Base URL resolution
    if base_url is not None and base_url.strip():
        resolved_base_url = base_url.strip()
    elif resolved_provider == PROVIDER_GEMINI:
        resolved_base_url = settings.gemini_base_url or DEFAULT_BASE_URLS[PROVIDER_GEMINI]
    elif resolved_provider == PROVIDER_NVIDIA:
        resolved_base_url = settings.nvidia_base_url or DEFAULT_BASE_URLS[PROVIDER_NVIDIA]
    else:
        resolved_base_url = None

    # Model resolution
    if model and model.strip():
        resolved_model = model.strip()
    elif not has_input_key and resolved_provider == settings.provider_name and os.getenv("LLM_MODEL"):
        resolved_model = settings.model
    else:
        resolved_model = DEFAULT_MODELS.get(resolved_provider, "gpt-4o-mini")

    is_configured = bool(resolved_key and resolved_key not in PLACEHOLDERS)

    return {
        "api_key": resolved_key,
        "provider": resolved_provider,
        "model": resolved_model,
        "base_url": resolved_base_url,
        "is_configured": is_configured,
        "is_gemini": resolved_provider == PROVIDER_GEMINI,
        "is_nvidia": resolved_provider == PROVIDER_NVIDIA,
        "is_openai": resolved_provider == PROVIDER_OPENAI,
    }


class Settings:
    """Application settings and LLM configuration."""

    def __init__(self) -> None:
        self.gemini_api_key: str | None = os.getenv("GEMINI_API_KEY")
        self.nvidia_api_key: str | None = os.getenv("NVIDIA_API_KEY")
        self.openai_api_key: str | None = os.getenv("OPENAI_API_KEY")

        # Resolve primary key
        raw_key = self.gemini_api_key or self.nvidia_api_key or self.openai_api_key or ""
        self._api_key: str = raw_key.strip()

        # Provider detection
        self.is_gemini: bool = bool(self.gemini_api_key)
        self.is_nvidia: bool = bool(
            self.nvidia_api_key
            or (self._api_key and self._api_key.startswith("nvapi-"))
        )

        # Gemini and NVIDIA use OpenAI-compatible endpoints.
        default_gemini_url = "https://generativelanguage.googleapis.com/v1beta/openai/"
        default_nvidia_url = "https://integrate.api.nvidia.com/v1"
        self.gemini_base_url: str = os.getenv("GEMINI_BASE_URL", default_gemini_url)
        self.nvidia_base_url: str = os.getenv("NVIDIA_BASE_URL", default_nvidia_url)
        self.base_url: str | None = (
            self.gemini_base_url if self.is_gemini else
            self.nvidia_base_url if self.is_nvidia else None
        )

        # Model resolution
        default_model = (
            "gemini-3.6-flash" if self.is_gemini else
            "meta/llama-3.2-11b-vision-instruct" if self.is_nvidia else "gpt-4o-mini"
        )
        self.model: str = os.getenv("LLM_MODEL", default_model)
        self.provider_name: str = (
            "Google Gemini" if self.is_gemini else
            "NVIDIA NIM" if self.is_nvidia else "OpenAI"
        )

        # Operational limits & hyper-parameters
        self.max_target_chars: int = int(os.getenv("MAX_TARGET_CHARS", "500"))
        self.max_context_chars: int = int(os.getenv("MAX_CONTEXT_CHARS", "5000"))
        self.llm_timeout_seconds: float = float(os.getenv("LLM_TIMEOUT_SECONDS", "30.0"))
        self.llm_temperature: float = float(os.getenv("LLM_TEMPERATURE", "0.1"))
        self.llm_max_tokens: int = int(os.getenv("LLM_MAX_TOKENS", "1024"))
        self.definition_cache_size: int = int(os.getenv("DEFINITION_CACHE_SIZE", "256"))
        self.definition_cache_ttl: float = float(os.getenv("DEFINITION_CACHE_TTL_SECONDS", "300"))

        # Server defaults
        self.host: str = os.getenv("HOST", "127.0.0.1")
        self.port: int = int(os.getenv("PORT", "8000"))
        self.backend_auth_token: str = os.getenv("BACKEND_AUTH_TOKEN", "").strip()
        self.credential_encryption_key: str = os.getenv(
            "CREDENTIAL_ENCRYPTION_KEY", ""
        ).strip()

    @property
    def api_key(self) -> str:
        """Returns the configured API key."""
        return self._api_key

    @property
    def is_configured(self) -> bool:
        """Checks if a valid, non-placeholder API key is available."""
        if not self._api_key:
            return False
        return self._api_key not in PLACEHOLDERS


settings = Settings()
