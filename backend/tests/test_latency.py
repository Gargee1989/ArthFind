"""Offline tests for cache isolation, connection reuse and progressive delivery."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.config import settings
from backend.exceptions import DefinitionUnavailableException, InvalidInputException, RateLimitedException
from backend.schemas import DefineResponse
from backend.services.definition_cache import DefinitionCache
from backend.services.llm_service import LLMService
from backend.services.streaming import MeaningPreview


ANSWER = dict(status="success", meaning='The land beside a river.', tone="", synonym="riverside", example="", simplified_passage="")
REQUEST = dict(target="bank", context="We sat on the river bank.", api_key="sk-test-a", provider="OpenAI", model="test-model")


@pytest.fixture
def service():
    instance = LLMService()
    yield instance
    instance.close()


def test_cache_returns_independent_copies(service):
    with patch.object(service, "_define_uncached", return_value=DefineResponse(**ANSWER)) as upstream:
        first = service.define(**REQUEST)
        first.meaning = "changed by caller"
        assert service.define(**REQUEST).meaning == ANSWER["meaning"]
        upstream.assert_called_once()


@pytest.mark.parametrize("field,value", [
    ("target", "Bank"), ("context", "She deposited money in the bank."),
    ("api_key", "sk-test-b"), ("provider", "NVIDIA NIM"),
    ("model", "another-model"), ("base_url", "https://other.example/v1"),
])
def test_cache_isolates_reading_and_provider_configuration(service, field, value):
    with patch.object(service, "_define_uncached", return_value=DefineResponse(**ANSWER)) as upstream:
        service.define(**REQUEST)
        service.define(**{**REQUEST, field: value})
        assert upstream.call_count == 2


def test_cache_invalidates_prompt_and_generation_changes(service, monkeypatch):
    with patch.object(service, "_define_uncached", return_value=DefineResponse(**ANSWER)) as upstream:
        service.define(**REQUEST)
        monkeypatch.setattr("backend.services.llm_service.SYSTEM_PROMPT", "updated instructions")
        service.define(**REQUEST)
        monkeypatch.setattr(settings, "llm_temperature", 0.2)
        service.define(**REQUEST)
        assert upstream.call_count == 3


def test_failures_are_not_cached(service):
    with patch.object(service, "_define_uncached", side_effect=[DefinitionUnavailableException(), DefineResponse(**ANSWER)]) as upstream:
        with pytest.raises(DefinitionUnavailableException):
            service.define(**REQUEST)
        assert service.define(**REQUEST).meaning == ANSWER["meaning"]
        assert upstream.call_count == 2


def test_cache_expires_evicts_and_can_be_disabled():
    compute = Mock(side_effect=lambda: DefineResponse(**ANSWER))
    cache = DefinitionCache(max_entries=1, ttl_seconds=5)
    with patch("backend.services.definition_cache.monotonic", return_value=0):
        cache.get_or_compute("a", compute)
        cache.get_or_compute("a", compute)
        assert compute.call_count == 1
        cache.get_or_compute("b", compute)
        cache.get_or_compute("a", compute)
        assert compute.call_count == 3
    with patch("backend.services.definition_cache.monotonic", return_value=6):
        cache.get_or_compute("a", compute)
        assert compute.call_count == 4
    cache.max_entries = 0
    cache.get_or_compute("a", compute)
    assert compute.call_count == 5


def test_concurrent_duplicates_share_one_request(service):
    started, release, joined = Event(), Event(), Event()
    def compute(*args):
        started.set()
        assert release.wait(3)
        return DefineResponse(**ANSWER)
    def second():
        joined.set()
        return service.define(**REQUEST)
    with patch.object(service, "_define_uncached", side_effect=compute) as upstream, ThreadPoolExecutor(2) as pool:
        first = pool.submit(service.define, **REQUEST)
        assert started.wait(3)
        other = pool.submit(second)
        assert joined.wait(3)
        release.set()
        assert first.result(timeout=3) == other.result(timeout=3)
        assert upstream.call_count == 1


def test_pool_reuse_preserves_per_request_credentials(service):
    headers = []
    def respond(request):
        headers.append(request.headers["authorization"])
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(ANSWER)}}]})
    service._http_client = httpx.Client(transport=httpx.MockTransport(respond))
    first = service.create_client("sk-test-a")
    second = service.create_client("sk-test-b")
    assert first._client is second._client
    service.define(**REQUEST)
    service.define(**{**REQUEST, "api_key": "sk-test-b"})
    assert headers == ["Bearer sk-test-a", "Bearer sk-test-b"]
    pool = service._http_client
    service.close()
    assert pool.is_closed


def test_preview_handles_split_escapes_and_waits_for_complete_meaning():
    seen = []
    preview = MeaningPreview(seen.append)
    raw = json.dumps({**ANSWER, "meaning": 'A "river" bank.\nEasy.'})
    split = raw.index(', "tone"')
    for char in raw[:split-1]:
        preview.add(char)
    assert seen == []
    preview.add(raw[split-1:split])
    assert seen == ['A "river" bank.\nEasy.']
    preview.add(raw[split:])
    assert len(seen) == 1


@pytest.mark.parametrize("raw", [
    '{"status":"more_context_needed","meaning":"guessed"',
    '{"status":"success","example":{"meaning":"wrong"}',
    '{"status":"success","meaning":42',
])
def test_preview_does_not_emit_invalid_or_nested_meaning(raw):
    seen = []
    MeaningPreview(seen.append).add(raw)
    assert seen == []


def test_real_sdk_stream_previews_before_full_response_and_caches(service):
    seen = []
    raw = json.dumps(ANSWER)
    split = raw.index(', "tone"')
    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield ('data: ' + json.dumps({"choices": [{"delta": {"content": raw[:split]}}]}) + '\n\n').encode()
            assert seen == [ANSWER["meaning"]]
            yield ('data: ' + json.dumps({"choices": [{"delta": {"content": raw[split:]}}]}) + '\n\n').encode()
            yield b'data: [DONE]\n\n'
    calls = []
    def respond(request):
        calls.append(request)
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Body())
    service._http_client = httpx.Client(transport=httpx.MockTransport(respond))
    assert service.define(**REQUEST, on_meaning=seen.append).model_dump() == ANSWER
    assert service.define(**REQUEST).model_dump() == ANSWER
    assert len(calls) == 1


def test_gemini_native_stream_uses_shared_pool(service):
    seen = []
    def respond(request):
        assert request.url.params["alt"] == "sse"
        assert request.url.path.endswith(":streamGenerateContent")
        assert request.headers["x-goog-api-key"] == "test-gemini-key"
        data = {"candidates": [{"content": {"parts": [{"text": json.dumps(ANSWER)}]}}]}
        return httpx.Response(200, text="data: " + json.dumps(data) + "\n\n")
    service._http_client = httpx.Client(transport=httpx.MockTransport(respond))
    result = service.define_with_gemini("test", api_key="test-gemini-key", on_meaning=seen.append)
    assert result.model_dump() == ANSWER
    assert seen == [ANSWER["meaning"]]


def test_stream_endpoint_preserves_final_contract():
    def define(**kwargs):
        kwargs["on_meaning"](ANSWER["meaning"])
        return DefineResponse(**ANSWER)
    with patch("backend.app.llm_service.define", side_effect=define):
        response = TestClient(app).post("/define", json=REQUEST, headers={"Accept": "text/event-stream"})
    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]
    assert response.text.index("event: meaning") < response.text.index("event: result")
    final = response.text.split("event: result\ndata: ")[1].strip()
    assert json.loads(final) == ANSWER


def test_stream_endpoint_errors_and_validation():
    client = TestClient(app)
    with patch("backend.app.llm_service.define", side_effect=RateLimitedException()):
        response = client.post("/define", json=REQUEST, headers={"Accept": "text/event-stream"})
    assert "event: error" in response.text
    assert "RATE_LIMITED" in response.text
    assert "event: result" not in response.text
    assert client.post("/define", json={}, headers={"Accept": "text/event-stream"}).status_code == 400


def test_invalid_stream_is_not_cached_after_preview(service):
    calls = []
    def respond(request):
        calls.append(request)
        # A valid meaning prefix followed by incomplete JSON must never enter the cache.
        text = '{"status":"success","meaning":"Preview",' if len(calls) == 1 else json.dumps(ANSWER)
        chunk = {"choices": [{"delta": {"content": text}}]}
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text="data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n")
    service._http_client = httpx.Client(transport=httpx.MockTransport(respond))
    seen = []
    with pytest.raises(DefinitionUnavailableException):
        service.define(**REQUEST, on_meaning=seen.append)
    assert seen == ["Preview"]
    assert service.define(**REQUEST, on_meaning=seen.append).model_dump() == ANSWER
    assert len(calls) == 2


@pytest.mark.parametrize("accept", ["application/json", "text/event-stream"])
def test_credential_authorization_precedes_cached_lookup(accept):
    cfg = dict(api_key=REQUEST["api_key"], provider="OpenAI", model="test-model", base_url=None)
    payload = {"target": REQUEST["target"], "context": REQUEST["context"], "credential_id": "test-id", "credential_token": "test-token"}
    with patch("backend.app.credential_service.resolve", side_effect=[cfg, InvalidInputException("Saved credential was not found.")]), patch("backend.app.llm_service.define", return_value=DefineResponse(**ANSWER)) as define:
        client = TestClient(app)
        assert client.post("/define", json=payload, headers={"Accept": accept}).status_code == 200
        assert client.post("/define", json=payload, headers={"Accept": accept}).status_code == 400
        define.assert_called_once()
