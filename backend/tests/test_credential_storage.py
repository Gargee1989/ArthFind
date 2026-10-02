"""Persistence, authorization and migration tests; all keys and databases are disposable."""

import base64
import sqlite3
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.schema import CreateTable
from sqlalchemy.dialects import postgresql

from backend.app import app
from backend.exceptions import DefinitionUnavailableException, InvalidInputException
from backend.migrate_credentials import import_credentials
from backend.services.credential_service import CredentialService


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"x" * 32).decode())
    service = CredentialService(db_path=tmp_path / "credentials.sqlite3")
    yield service
    service.engine.dispose()


def register(store, key="sk-disposable-test-only"):
    return store.register("OpenAI", key, model="test-model", verify=False)


def test_restart_resolves_the_same_user_connection(store):
    saved = register(store)
    store.engine.dispose()
    restarted = CredentialService(db_path=store.db_path)
    try:
        resolved = restarted.resolve(saved["credential_id"], saved["credential_token"])
        assert resolved["api_key"] == "sk-disposable-test-only"
        assert resolved["model"] == "test-model"
        with restarted.engine.connect() as connection:
            row = connection.execute(select(restarted.credentials)).mappings().one()
        assert row["encrypted_api_key"] != resolved["api_key"]
        assert resolved["api_key"] not in row["encrypted_api_key"]
        assert row["token_hash"] != saved["credential_token"]
        assert "api_key" not in saved
    finally:
        restarted.engine.dispose()


def test_users_cannot_access_or_delete_each_others_keys(store):
    a, b = register(store, "sk-user-a"), register(store, "sk-user-b")
    assert a["credential_id"] != b["credential_id"]
    for bad_token in ("", b["credential_token"], "guessed-token"):
        with pytest.raises(InvalidInputException):
            store.resolve(a["credential_id"], bad_token)
        with pytest.raises(InvalidInputException):
            store.delete(a["credential_id"], bad_token)
    assert store.resolve(a["credential_id"], a["credential_token"])["api_key"] == "sk-user-a"
    assert store.delete(a["credential_id"], a["credential_token"])
    with pytest.raises(InvalidInputException):
        store.resolve(a["credential_id"], a["credential_token"])
    assert store.resolve(b["credential_id"], b["credential_token"])["api_key"] == "sk-user-b"


def test_missing_key_is_not_silently_regenerated(store, monkeypatch):
    monkeypatch.delenv("CREDENTIAL_ENCRYPTION_KEY")
    with pytest.raises(DefinitionUnavailableException, match="persistent CREDENTIAL_ENCRYPTION_KEY"):
        register(store)
    assert not store.encryption_configured


def test_changed_encryption_key_cannot_read_existing_credentials(store, monkeypatch):
    saved = register(store)
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"y" * 32).decode())
    with pytest.raises(DefinitionUnavailableException, match="decrypt"):
        store.resolve(saved["credential_id"], saved["credential_token"])


def test_render_allows_sqlite_fallback_without_database_url(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    service = CredentialService(database_url="")
    try:
        assert service.storage_backend == "sqlite"
    finally:
        service.engine.dispose()


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+psycopg"])
def test_render_url_uses_psycopg_and_postgresql_schema(scheme):
    service = CredentialService(database_url=f"{scheme}://test:test@localhost/test")
    try:
        assert service.engine.url.drivername == "postgresql+psycopg"
        ddl = str(CreateTable(service.credentials).compile(dialect=postgresql.dialect()))
        assert "PRIMARY KEY (credential_id)" in ddl
        assert "encrypted_api_key TEXT NOT NULL" in ddl
    finally:
        service.engine.dispose()


def test_legacy_sqlite_schema_is_reused(tmp_path, store):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute("""CREATE TABLE credentials (
            credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
            provider TEXT NOT NULL, model TEXT, base_url TEXT,
            encrypted_api_key TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
        connection.execute("INSERT INTO credentials (credential_id,token_hash,provider,encrypted_api_key) VALUES (?,?,?,?)",
                           ("legacy-id", store._hash_token("legacy-token"), "OpenAI", store._encrypt_api_key("OpenAI", "legacy-key")))
    legacy = CredentialService(db_path=path)
    try:
        assert legacy.resolve("legacy-id", "legacy-token")["api_key"] == "legacy-key"
    finally:
        legacy.engine.dispose()


def test_migration_preserves_ids_and_can_be_repeated(store, tmp_path):
    saved = register(store)
    target = CredentialService(db_path=tmp_path / "target.sqlite3")
    try:
        assert import_credentials(store.db_path, target) == 1
        assert import_credentials(store.db_path, target) == 0
        assert target.resolve(saved["credential_id"], saved["credential_token"])["api_key"] == "sk-disposable-test-only"
        assert store.resolve(saved["credential_id"], saved["credential_token"])["api_key"] == "sk-disposable-test-only"
        with target.engine.begin() as connection:
            connection.execute(update(target.credentials).values(model="different-model"))
        with pytest.raises(ValueError, match="Conflicting"):
            import_credentials(store.db_path, target)
    finally:
        target.engine.dispose()


def test_lookup_after_backend_restart_uses_stored_key(store):
    with patch("backend.app.credential_service", store), patch.object(store, "verify_credentials"):
        response = TestClient(app).post("/credentials", json={"provider": "OpenAI", "api_key": "sk-persistent-test"})
    assert response.status_code == 200
    saved = response.json()
    store.engine.dispose()
    restarted = CredentialService(db_path=store.db_path)
    try:
        with patch("backend.app.credential_service", restarted), patch("backend.app.llm_service.define") as define:
            define.return_value.model_dump.return_value = {"status": "success", "meaning": "test"}
            response = TestClient(app).post("/define", json={"word": "word", "context": "A word in context.",
                "credential_id": saved["credential_id"], "credential_token": saved["credential_token"]})
            assert response.status_code == 200
            assert define.call_args.kwargs["api_key"] == "sk-persistent-test"
            assert "sk-persistent-test" not in response.text
            define.reset_mock()
            response = TestClient(app).post("/define", json={"word": "word", "context": "A word in context.",
                "credential_id": saved["credential_id"], "credential_token": "wrong-token"})
            assert response.status_code == 400
            define.assert_not_called()
    finally:
        restarted.engine.dispose()
