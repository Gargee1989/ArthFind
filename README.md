# Context Core
Context Core is an AI-powered browser extension that gives PDF and e-book readers instant, context-aware word meanings — right on the page, with no new tabs or interruptions. It uses an LLM to explain what a word means in the context of what you're reading, helping readers stay focused and finish books faster.

## PDF reader

Open the extension popup and choose **Open PDF reader**. Select a local PDF or enter a PDF URL to open it with the bundled PDF.js viewer. Text rendered by the viewer can be selected for the existing Context Core lookup flow.

## Backend

The official backend is the Python FastAPI app in `backend/app.py`.

Run it from the project root with:

```bash
uvicorn backend.app:app --reload --port 8000
```

The extension connects to the backend endpoint configured in `extension/crypto.js` (`BACKEND_ENDPOINT`). For local development, this defaults to:

```text
http://127.0.0.1:8000/define
```

The extension sends `POST /define` with `word` and `context`. Provider API calls happen only in the backend; the extension never receives or sends Gemini, OpenAI, or NVIDIA provider keys. The backend accepts the word aliases used by the extension and returns a response containing `meaning`, which the extension displays as the explanation.

The backend supports Google Gemini, OpenAI, and NVIDIA NIM. Configure the fallback provider key and model in `backend/.env` or the deployment environment.

For BYOK mode, the extension sends the user's provider key once to `POST /credentials`. The backend encrypts the key with `CREDENTIAL_ENCRYPTION_KEY` and returns an opaque credential reference. Subsequent `/define` requests send only that reference; provider keys never return to the extension after registration.

For persistent credentials on Render, configure PostgreSQL with `DATABASE_URL`
and keep `CREDENTIAL_ENCRYPTION_KEY` unchanged across deployments. See
[database setup and migration](backend/DATABASE.md). The root `render.yaml`
prepares the backend and its database as a Render Blueprint.
