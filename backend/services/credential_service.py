"""Encrypted server-side storage for user-supplied provider credentials."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import uuid
from pathlib import Path
from threading import Lock

from sqlalchemy import Column, DateTime, MetaData, String, Table, Text, create_engine, delete, insert, select, text
from sqlalchemy.engine import make_url, URL
from sqlalchemy.exc import SQLAlchemyError
import httpx
from openai import (
    OpenAI,
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    APIConnectionError,
    APITimeoutError,
    APIStatusError,
    OpenAIError,
)

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from backend.config import (
    DEFAULT_BASE_URLS,
    DEFAULT_MODELS,
    PLACEHOLDERS,
    PROVIDER_GEMINI,
    SUPPORTED_PROVIDERS,
    normalize_provider_name,
)
from backend.exceptions import DefinitionUnavailableException, InvalidInputException


class CredentialService:
    """Manages encrypted storage and resolution of provider credentials."""

    def __init__(self, db_path: Path | None = None, database_url: str | None = None) -> None:
        default_path = Path(__file__).resolve().parent.parent / ".credentials.sqlite3"
        self.db_path = Path(db_path) if db_path is not None else default_path
        # An explicit file path is useful for isolated tests and legacy imports.
        configured_url = database_url if database_url is not None else os.getenv("DATABASE_URL", "").strip()
        if db_path is not None or not configured_url:
            url = URL.create("sqlite", database=str(self.db_path))
        else:
            url = make_url(configured_url)
            if url.drivername in ("postgres", "postgresql"):
                url = url.set(drivername="postgresql+psycopg")
            if url.get_backend_name() not in ("sqlite", "postgresql"):
                raise DefinitionUnavailableException("Credential storage requires PostgreSQL or SQLite.")
            if os.getenv("RENDER") == "true" and url.get_backend_name() != "postgresql":
                raise DefinitionUnavailableException("Use PostgreSQL for persistent credentials on Render.")
        self.storage_backend = url.get_backend_name()
        options = {"pool_pre_ping": True, "hide_parameters": True}
        if self.storage_backend == "sqlite":
            if url.database and url.database != ":memory:":
                Path(url.database).parent.mkdir(parents=True, exist_ok=True)
            options["connect_args"] = {"check_same_thread": False, "timeout": 15}
        else:
            options["connect_args"] = {"connect_timeout": 10}
        self.engine = create_engine(url, **options)
        self.metadata = MetaData()
        # Keep the legacy SQLite schema so existing IDs and ciphertext remain valid.
        self.credentials = Table(
            "credentials", self.metadata,
            Column("credential_id", String(36), primary_key=True),
            Column("token_hash", String(64), nullable=False),
            Column("provider", Text, nullable=False),
            Column("model", Text),
            Column("base_url", Text),
            Column("encrypted_api_key", Text, nullable=False),
            Column("created_at", DateTime, server_default=text("CURRENT_TIMESTAMP")),
        )
        self._schema_ready = False
        self._schema_lock = Lock()

    def _ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with self._schema_lock:
            if self._schema_ready:
                return
            try:
                self.metadata.create_all(self.engine)
            except SQLAlchemyError as error:
                raise DefinitionUnavailableException("Credential database is unavailable. Please try again later.") from error
            self._schema_ready = True

    def initialize(self) -> None:
        """Fail startup on missing encryption configuration or unavailable storage."""
        self._encryption_key()
        self._ensure_schema()

    @property
    def encryption_configured(self) -> bool:
        try:
            self._encryption_key()
            return True
        except DefinitionUnavailableException:
            return False

    @staticmethod
    def _encryption_key() -> bytes:
        raw_key = os.getenv("CREDENTIAL_ENCRYPTION_KEY", "").strip()
        if not raw_key:
            raise DefinitionUnavailableException(
                "Set a persistent CREDENTIAL_ENCRYPTION_KEY before storing user credentials."
            )

        try:
            key = base64.b64decode(raw_key.encode(), altchars=b"-_", validate=True)
        except Exception as error:
            raise DefinitionUnavailableException(
                "Credential storage encryption is misconfigured."
            ) from error
        if len(key) != 32:
            raise DefinitionUnavailableException(
                "Credential storage encryption is misconfigured."
            )
        return key

    def _encrypt_api_key(self, provider: str, api_key: str) -> str:
        aesgcm = AESGCM(self._encryption_key())
        nonce = secrets.token_bytes(12)
        ciphertext = aesgcm.encrypt(nonce, api_key.encode("utf-8"), provider.encode("utf-8"))
        payload = nonce + ciphertext
        return base64.b64encode(payload).decode("utf-8")

    def _decrypt_api_key(self, provider: str, payload_b64: str) -> str:
        try:
            raw = base64.b64decode(payload_b64.encode("utf-8"))
            if len(raw) <= 12:
                raise ValueError("Invalid encrypted payload.")
            nonce = raw[:12]
            ciphertext = raw[12:]
            aesgcm = AESGCM(self._encryption_key())
            plaintext = aesgcm.decrypt(nonce, ciphertext, provider.encode("utf-8"))
            return plaintext.decode("utf-8")
        except Exception as error:
            raise DefinitionUnavailableException(
                "Failed to decrypt stored provider credentials."
            ) from error

    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def verify_credentials(
        self,
        provider: str,
        api_key: str,
        model: str,
        base_url: str | None = None,
    ) -> None:
        """
        Performs a lightweight test call to verify API key and model before saving.
        Raises InvalidInputException with descriptive messages on failures.
        """
        try:
            client = OpenAI(
                api_key=api_key,
                base_url=base_url or None,
                timeout=10.0,
            )
            client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "test"}],
                max_tokens=1,
            )
        except AuthenticationError as exc:
            raise InvalidInputException(
                f"Invalid API key for {provider}. Please verify your key in the provider's dashboard."
            ) from exc
        except NotFoundError as exc:
            raise InvalidInputException(
                f"Model '{model}' does not exist or is unavailable for {provider}. Please check the model name."
            ) from exc
        except RateLimitError as exc:
            raise InvalidInputException(
                "The provider API key has exceeded its quota or rate limit."
            ) from exc
        except (APIConnectionError, APITimeoutError, httpx.ConnectError, httpx.TimeoutException) as exc:
            raise InvalidInputException(
                f"Could not connect to {provider} servers to verify the key. Please check your internet connection or try again later."
            ) from exc
        except APIStatusError as exc:
            if exc.status_code in (401, 403):
                raise InvalidInputException(
                    f"Invalid API key for {provider}. Please verify your key in the provider's dashboard."
                ) from exc
            if exc.status_code == 404:
                raise InvalidInputException(
                    f"Model '{model}' does not exist or is unavailable for {provider}. Please check the model name."
                ) from exc
            if exc.status_code == 429:
                raise InvalidInputException(
                    "The provider API key has exceeded its quota or rate limit."
                ) from exc
            if exc.status_code and exc.status_code >= 500:
                raise InvalidInputException(
                    f"Could not connect to {provider} servers to verify the key. Please check your internet connection or try again later."
                ) from exc
            raise InvalidInputException(
                f"Could not connect to {provider} servers to verify the key. Please check your internet connection or try again later."
            ) from exc
        except OpenAIError as exc:
            error_str = str(exc).lower()
            if any(k in error_str for k in ["401", "403", "auth", "unauthorized", "forbidden", "invalid api key", "invalid key", "invalid_api_key", "api key not valid", "bearer token", "permission denied", "access denied"]):
                raise InvalidInputException(
                    f"Invalid API key for {provider}. Please verify your key in the provider's dashboard."
                ) from exc
            if any(k in error_str for k in ["404", "not found", "does not exist", "model_not_found"]):
                raise InvalidInputException(
                    f"Model '{model}' does not exist or is unavailable for {provider}. Please check the model name."
                ) from exc
            if any(k in error_str for k in ["429", "rate limit", "quota", "insufficient_quota"]):
                raise InvalidInputException(
                    "The provider API key has exceeded its quota or rate limit."
                ) from exc
            raise InvalidInputException(
                f"Could not connect to {provider} servers to verify the key. Please check your internet connection or try again later."
            ) from exc
        except Exception as exc:
            if isinstance(exc, InvalidInputException):
                raise
            err_str = str(exc).lower()
            if any(k in err_str for k in ["401", "403", "unauthorized", "forbidden", "invalid api key", "invalid key", "invalid_api_key", "api key not valid", "bearer token", "permission denied", "access denied"]):
                raise InvalidInputException(
                    f"Invalid API key for {provider}. Please verify your key in the provider's dashboard."
                ) from exc
            raise InvalidInputException(
                f"Could not connect to {provider} servers to verify the key. Please check your internet connection or try again later."
            ) from exc

    def register(
        self,
        provider: str,
        api_key: str,
        model: str | None = None,
        base_url: str | None = None,
        verify: bool = True,
    ) -> dict[str, str | None]:
        self.initialize()
        normalized_provider = normalize_provider_name(provider)
        if normalized_provider not in SUPPORTED_PROVIDERS:
            raise InvalidInputException(
                "Provider must be Google Gemini, OpenAI, or NVIDIA NIM."
            )

        clean_api_key = api_key.strip()
        if not clean_api_key or clean_api_key in PLACEHOLDERS:
            raise InvalidInputException("A valid provider API key is required.")

        resolved_model = (model or "").strip() or DEFAULT_MODELS[normalized_provider]
        resolved_base_url = (base_url or "").strip() or DEFAULT_BASE_URLS[normalized_provider]

        if verify:
            self.verify_credentials(
                provider=normalized_provider,
                api_key=clean_api_key,
                model=resolved_model,
                base_url=resolved_base_url,
            )

        credential_id = str(uuid.uuid4())
        access_token = secrets.token_urlsafe(32)
        encrypted_api_key = self._encrypt_api_key(normalized_provider, clean_api_key)

        self._ensure_schema()
        try:
            with self.engine.begin() as connection:
                connection.execute(insert(self.credentials).values(
                    credential_id=credential_id,
                    token_hash=self._hash_token(access_token),
                    provider=normalized_provider,
                    model=resolved_model,
                    base_url=resolved_base_url,
                    encrypted_api_key=encrypted_api_key,
                ))
        except SQLAlchemyError as error:
            raise DefinitionUnavailableException("Unable to save credentials. Please try again later.") from error

        return {
            "credential_id": credential_id,
            "credential_token": access_token,
            "provider": normalized_provider,
            "model": resolved_model,
        }

    def resolve(self, credential_id: str, credential_token: str) -> dict[str, str | None]:
        clean_id = credential_id.strip()
        clean_token = credential_token.strip()
        if not clean_id or not clean_token:
            raise InvalidInputException("Invalid credential reference.")

        self._ensure_schema()
        try:
            with self.engine.connect() as connection:
                row = connection.execute(select(
                    self.credentials.c.provider, self.credentials.c.model,
                    self.credentials.c.base_url, self.credentials.c.encrypted_api_key,
                    self.credentials.c.token_hash,
                ).where(self.credentials.c.credential_id == clean_id)).first()
        except SQLAlchemyError as error:
            raise DefinitionUnavailableException("Credential database is unavailable. Please try again later.") from error

        if not row:
            raise InvalidInputException("Saved credential was not found.")

        provider, model, base_url, encrypted_api_key, stored_hash = row
        if not secrets.compare_digest(stored_hash, self._hash_token(clean_token)):
            raise InvalidInputException("Invalid credential access token.")

        api_key = self._decrypt_api_key(provider, encrypted_api_key)
        return {
            "api_key": api_key,
            "provider": provider,
            "model": model,
            "base_url": base_url,
        }

    def delete(self, credential_id: str, credential_token: str) -> bool:
        clean_id = credential_id.strip()
        clean_token = credential_token.strip()
        if not clean_id or not clean_token:
            raise InvalidInputException("Invalid credential reference.")

        self._ensure_schema()
        try:
            with self.engine.begin() as connection:
                row = connection.execute(select(self.credentials.c.token_hash).where(
                    self.credentials.c.credential_id == clean_id
                )).first()
                if not row or not secrets.compare_digest(row[0], self._hash_token(clean_token)):
                    raise InvalidInputException("Saved credential was not found.")
                connection.execute(delete(self.credentials).where(
                    self.credentials.c.credential_id == clean_id,
                    self.credentials.c.token_hash == self._hash_token(clean_token),
                ))
            return True
        except SQLAlchemyError as error:
            raise DefinitionUnavailableException("Unable to remove credentials. Please try again later.") from error



credential_service = CredentialService()
