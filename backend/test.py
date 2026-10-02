"""
ContentCore - Backend LLM API Direct Connection & Test

Directly calls the configured LLM API provider by taking inputs (provider, API key, model),
or falling back to environment variables from backend/.env.

The 3 supported providers (defined in docs/STEP.md) are:
1. Google Gemini (default model: gemini-3.6-flash)
2. OpenAI (default model: gpt-4o-mini)
3. NVIDIA NIM (default model: meta/llama-3.2-11b-vision-instruct)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any
from dotenv import load_dotenv
import httpx
from openai import OpenAI, AuthenticationError, APIConnectionError, OpenAIError

# Directory paths
BACKEND_DIR = Path(__file__).resolve().parent
ENV_FILE_PATH = BACKEND_DIR / ".env"

if ENV_FILE_PATH.exists():
    load_dotenv(dotenv_path=ENV_FILE_PATH)
else:
    load_dotenv()

# The 3 supported LLM API providers from docs/STEP.md
PROVIDER_GEMINI = "Google Gemini"
PROVIDER_OPENAI = "OpenAI"
PROVIDER_NVIDIA = "NVIDIA NIM"

SUPPORTED_PROVIDERS = [PROVIDER_GEMINI, PROVIDER_OPENAI, PROVIDER_NVIDIA]

PROVIDER_MAP = {
    "1": PROVIDER_GEMINI,
    "gemini": PROVIDER_GEMINI,
    "google": PROVIDER_GEMINI,
    "google gemini": PROVIDER_GEMINI,

    "2": PROVIDER_OPENAI,
    "openai": PROVIDER_OPENAI,

    "3": PROVIDER_NVIDIA,
    "nvidia": PROVIDER_NVIDIA,
    "nim": PROVIDER_NVIDIA,
    "nvidia nim": PROVIDER_NVIDIA,
}

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

PLACEHOLDERS = {
    "your_gemini_api_key_here",
    "your_openai_api_key_here",
    "your_nvidia_api_key_here",
    "nvapi-yourActualKeyHere",
    "sk-proj-yourActualKeyHere",
}


def detect_provider_from_key(api_key: str) -> str:
    """Infers the provider from key prefixes if not explicitly specified."""
    key = api_key.strip()
    if key.startswith("nvapi-"):
        return PROVIDER_NVIDIA
    if key.startswith("AIza"):
        return PROVIDER_GEMINI
    if key.startswith("sk-"):
        return PROVIDER_OPENAI
    return PROVIDER_OPENAI


def call_llm(
    provider: str,
    api_key: str,
    model: str | None = None,
    base_url: str | None = None,
    prompt: str = "Say 'ContentCore backend is successfully connected!' in a single short sentence.",
) -> str:
    """
    Directly calls the specified LLM provider with the given API key, model, and prompt.
    Returns the text reply from the provider.
    """
    provider_name = PROVIDER_MAP.get(provider.strip().lower(), provider.strip())
    resolved_model = model.strip() if model and model.strip() else DEFAULT_MODELS.get(provider_name, "gpt-4o-mini")
    resolved_base_url = (
        base_url.strip() if base_url and base_url.strip() else DEFAULT_BASE_URLS.get(provider_name)
    )

    if provider_name == PROVIDER_GEMINI:
        # First attempt OpenAI-compatible endpoint as documented in docs/STEP.md
        try:
            client = OpenAI(
                base_url=resolved_base_url or DEFAULT_BASE_URLS[PROVIDER_GEMINI],
                api_key=api_key,
                timeout=30.0,
            )
            response = client.chat.completions.create(
                model=resolved_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a helpful assistant verifying system connectivity for ContentCore.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=40,
                temperature=0.2,
            )
            return (response.choices[0].message.content or "").strip()
        except Exception:
            # Fallback to native Gemini generateContent endpoint
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{resolved_model}:generateContent"
            res = httpx.post(
                url,
                headers={"x-goog-api-key": api_key},
                json={"contents": [{"role": "user", "parts": [{"text": prompt}]}]},
                timeout=30.0,
            )
            res.raise_for_status()
            data = res.json()
            return data["candidates"][0]["content"]["parts"][0]["text"].strip()

    # NVIDIA NIM or OpenAI
    if resolved_base_url:
        client = OpenAI(base_url=resolved_base_url, api_key=api_key, timeout=30.0)
    else:
        client = OpenAI(api_key=api_key, timeout=30.0)

    response = client.chat.completions.create(
        model=resolved_model,
        messages=[
            {
                "role": "system",
                "content": "You are a helpful assistant verifying system connectivity for ContentCore.",
            },
            {"role": "user", "content": prompt},
        ],
        max_tokens=40,
        temperature=0.2,
    )
    return (response.choices[0].message.content or "").strip()


def test_connection(
    provider: str | None = None,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    prompt: str = "Say 'ContentCore backend is successfully connected!' in a single short sentence.",
) -> str | None:
    """
    Validates input parameters (or prompts for them interactively), executes the API call,
    and displays status output.
    """
    # Interactive input handling if run directly in a terminal and no credentials supplied
    if not api_key and sys.stdin.isatty():
        print("=" * 65)
        print("ContentCore - LLM API Direct Connection & Test")
        print("=" * 65)
        print("Supported Providers (from docs/STEP.md):")
        print("  [1] Google Gemini (default model: gemini-3.6-flash)")
        print("  [2] OpenAI        (default model: gpt-4o-mini)")
        print("  [3] NVIDIA NIM    (default model: meta/llama-3.2-11b-vision-instruct)")
        print("=" * 65)

        if not provider:
            user_provider = input("Select provider [1/2/3] (or Enter to detect from key/.env): ").strip()
            if user_provider:
                provider = PROVIDER_MAP.get(user_provider.lower(), user_provider)

        user_key = input("Enter API key (or Enter to check .env): ").strip()
        if user_key:
            api_key = user_key

        if provider:
            canonical_provider = PROVIDER_MAP.get(provider.lower(), provider)
            default_model = DEFAULT_MODELS.get(canonical_provider, "gpt-4o-mini")
        else:
            default_model = "gpt-4o-mini"

        if not model:
            user_model = input(f"Enter model name (or Enter for default [{default_model}]): ").strip()
            if user_model:
                model = user_model

    # Resolve from environment fallback if still not provided
    if not api_key:
        gemini_env = os.getenv("GEMINI_API_KEY")
        nvidia_env = os.getenv("NVIDIA_API_KEY")
        openai_env = os.getenv("OPENAI_API_KEY")

        if provider:
            canonical = PROVIDER_MAP.get(provider.lower(), provider)
            if canonical == PROVIDER_GEMINI:
                api_key = gemini_env
            elif canonical == PROVIDER_NVIDIA:
                api_key = nvidia_env
            elif canonical == PROVIDER_OPENAI:
                api_key = openai_env
        else:
            if gemini_env:
                provider = PROVIDER_GEMINI
                api_key = gemini_env
            elif nvidia_env:
                provider = PROVIDER_NVIDIA
                api_key = nvidia_env
            elif openai_env:
                provider = PROVIDER_OPENAI
                api_key = openai_env

    # Validate resolved key
    if not api_key or api_key.strip() in PLACEHOLDERS:
        print("=" * 65)
        print("[ERROR] No valid API key provided or found in environment!")
        print("=" * 65)
        print("You can pass the API key directly:")
        print("  python backend/test.py --provider gemini --api-key <YOUR_KEY>")
        print("  python backend/test.py --provider openai --api-key <YOUR_KEY>")
        print("  python backend/test.py --provider nvidia --api-key <YOUR_KEY>")
        print("=" * 65)
        return None

    api_key = api_key.strip()
    if not provider:
        provider = detect_provider_from_key(api_key)

    canonical_provider = PROVIDER_MAP.get(provider.lower(), provider)
    resolved_model = model.strip() if model and model.strip() else os.getenv("LLM_MODEL") or DEFAULT_MODELS.get(canonical_provider, "gpt-4o-mini")
    resolved_base_url = (
        base_url.strip()
        if base_url and base_url.strip()
        else (
            os.getenv("GEMINI_BASE_URL", DEFAULT_BASE_URLS[PROVIDER_GEMINI])
            if canonical_provider == PROVIDER_GEMINI
            else os.getenv("NVIDIA_BASE_URL", DEFAULT_BASE_URLS[PROVIDER_NVIDIA])
            if canonical_provider == PROVIDER_NVIDIA
            else None
        )
    )

    print(f"Provider: {canonical_provider}")
    print(f"Model: {resolved_model}")
    if resolved_base_url:
        print(f"Endpoint URL: {resolved_base_url}")
    print(f"Sending direct test request to {canonical_provider} API...")

    try:
        reply = call_llm(
            provider=canonical_provider,
            api_key=api_key,
            model=resolved_model,
            base_url=resolved_base_url,
            prompt=prompt,
        )
        print("=" * 65)
        print(f"[SUCCESS] {canonical_provider} API Response:")
        print("=" * 65)
        print(reply)
        print("=" * 65)
        return reply

    except AuthenticationError as auth_err:
        print("=" * 65)
        print(f"[AUTHENTICATION ERROR] Invalid {canonical_provider} API Key.")
        print(f"Details: {auth_err}")
        print("=" * 65)
    except APIConnectionError as conn_err:
        print("=" * 65)
        print(f"[CONNECTION ERROR] Could not reach {canonical_provider} servers.")
        print(f"Details: {conn_err}")
        print("=" * 65)
    except OpenAIError as api_err:
        print("=" * 65)
        print(f"[API ERROR] {canonical_provider} encountered an error: {api_err}")
        print("=" * 65)
    except httpx.HTTPStatusError as http_err:
        print("=" * 65)
        print(f"[HTTP ERROR] {canonical_provider} returned status code {http_err.response.status_code}")
        print(f"Details: {http_err}")
        print("=" * 65)
    except Exception as unexpected_err:
        print("=" * 65)
        print(f"[UNEXPECTED ERROR] An unexpected error occurred: {unexpected_err}")
        print("=" * 65)

    return None


def main():
    parser = argparse.ArgumentParser(
        description="Directly call and test supported LLM API providers (Google Gemini, OpenAI, NVIDIA NIM)."
    )
    parser.add_argument(
        "--provider",
        "-p",
        choices=["gemini", "google", "openai", "nvidia", "nim", "1", "2", "3"],
        help="LLM provider: 1/gemini (Google Gemini), 2/openai (OpenAI), 3/nvidia (NVIDIA NIM)",
    )
    parser.add_argument(
        "--api-key",
        "-k",
        help="Direct API key for the chosen provider",
    )
    parser.add_argument(
        "--model",
        "-m",
        help="Model name (optional; defaults to provider recommended model from docs/STEP.md)",
    )
    parser.add_argument(
        "--base-url",
        "-u",
        help="Custom base URL (optional)",
    )
    parser.add_argument(
        "--prompt",
        default="Say 'ContentCore backend is successfully connected!' in a single short sentence.",
        help="Test prompt to send",
    )

    args = parser.parse_args()
    test_connection(
        provider=args.provider,
        api_key=args.api_key,
        model=args.model,
        base_url=args.base_url,
        prompt=args.prompt,
    )


if __name__ == "__main__":
    main()
