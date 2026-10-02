# ContentCore Setup Steps

This project uses **FastAPI**, not Flask.

## 1. Open the project folder

All commands below should be run from the repository root:

```text
/Users/rajuram/Desktop/ContentCore
```

In a terminal:

```bash
cd /Users/rajuram/Desktop/ContentCore
```

## 2. Create the Python environment

Create the environment once:

```bash
python3 -m venv .venv
```

Activate it whenever you work on the backend:

macOS/Linux:

```bash
source .venv/bin/activate
```

Windows:

```powershell
.venv\Scripts\activate
```

After activation, the terminal should show `(.venv)`.

## 3. Install backend packages

With the environment activated, run:

```bash
python -m pip install -r backend/requirements.txt
```

The backend uses:

- FastAPI
- Uvicorn
- Pydantic
- OpenAI-compatible client
- HTTPX
- cryptography (AES-GCM credential encryption)
- python-dotenv
- pytest

## 4. Configure an LLM provider

The backend supports the 3 providers listed below:

- Google Gemini
- OpenAI
- NVIDIA NIM

Provider credentials must remain on the backend. Configure the provider key and model in `.env` for local development or in deployment environment variables. The extension sends only selected text and context to `/define`; it never receives or sends Gemini, OpenAI, or NVIDIA provider keys.

For the extension's BYOK mode, set a separate backend encryption key. Generate one with:

```powershell
python -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
```

Add the generated value to `backend/.env` or your deployment secret store:

```env
CREDENTIAL_ENCRYPTION_KEY=the_generated_value
```

The extension sends a user-supplied provider key once to `POST /credentials`. The backend encrypts it and returns an opaque credential reference. Later `/define` requests use only that reference.

Create this file:

```text
backend/.env
```

For Google Gemini:

```env
GEMINI_API_KEY=put_your_real_key_here
LLM_MODEL=gemini-3.6-flash
```

The backend uses Gemini's OpenAI-compatible endpoint automatically. You can override it with `GEMINI_BASE_URL` if needed.

For OpenAI:

```env
OPENAI_API_KEY=put_your_real_key_here
LLM_MODEL=gpt-4o-mini
```

For NVIDIA NIM:

```env
NVIDIA_API_KEY=put_your_real_key_here
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_MODEL=your-model-name
```

Never commit `backend/.env` or send the key in chat. `.env` is ignored by Git.

The backend reads this file through:

```text
backend/config.py
```

## 5. Start the FastAPI backend

From the repository root, with `.venv` active:

```bash
python -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000
```

Keep this terminal running.

The local backend URL is:

```text
http://127.0.0.1:8000
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

The response should contain `"status":"healthy"`.

## 6. Test the definition endpoint

Run this in a second terminal:

```bash
curl -X POST http://127.0.0.1:8000/define \
  -H "Content-Type: application/json" \
  -d '{"word":"bank","context":"She sat beside the bank of the river."}'
```

A successful response contains fields such as:

```json
{
  "status": "success",
  "meaning": "...",
  "tone": "...",
  "synonym": "...",
  "example": "...",
  "simplified_passage": "..."
}
```

If the response says the definition service is unavailable, check the provider key in `backend/.env` and restart Uvicorn.

## 7. Run backend tests

With `.venv` active:

```bash
python -m pytest backend/tests -q
```

All tests should pass before pushing backend changes.

## 8. Load the browser extension

1. Open Chrome or Edge.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder:

```text
/Users/rajuram/Desktop/ContentCore/extension
```

6. Click the ContentCore extension icon.
7. Under **Bring Your Own Provider Key**, select Google Gemini, OpenAI, or NVIDIA NIM.
8. Enter your provider API key and optionally enter a model.
9. Click **Save settings**. The provider key is registered once and is not stored in the extension after registration.

Note: The backend endpoint URL is hardcoded in `extension/crypto.js` (`BACKEND_ENDPOINT`). To change it after deploying your backend, update `BACKEND_ENDPOINT` in `extension/crypto.js`.

## 9. How to check API key encryption

Use a test key, not a real provider key, while verifying storage.

1. Open the ContentCore popup.
2. Right-click inside the popup and choose **Inspect**.
3. Select a provider, enter a test value such as `test-key-not-real`, and click **Save settings**.
4. In the popup DevTools Console, run:

```javascript
const data = await chrome.storage.local.get(null);
console.log(data);
```

The storage should contain these keys:

```text
contentCoreCredentialId
contentCoreCredentialTokenEncrypted
contentCoreEncryptionKey
```

It should not contain the plaintext keys:

```text
contentCoreApiKey
contentCoreLlmApiKey
```

Inspect the encrypted credential token:

```javascript
JSON.parse(data.contentCoreCredentialTokenEncrypted)
```

The result should contain `iv` and `ciphertext`. Confirm that settings can still be decrypted without exposing the API key:

```javascript
const settings = await ContentCoreCrypto.readSettings();
console.log(Boolean(settings.contentCoreCredentialToken));
```

The command should print `true`. Finally, verify that a lookup still works. The backend credential token is decrypted in extension memory and sent to the configured backend; the provider API key is not sent. Use an HTTPS endpoint for production.

## 10. Test the complete flow

### Webpage

1. Open any webpage with selectable text.
2. Highlight a word or phrase.
3. Click **Explain**.
4. The extension sends `word` and nearby `context` to `POST /define`.
5. The returned `meaning` appears in the popup.
6. Click **Save** to store the lookup locally in Chrome storage.

### PDF

1. Open the extension popup.
2. Click **Open ContentCore PDF Reader**.
3. Choose a local PDF.
4. Highlight text in the PDF.
5. Click **Explain**.
6. After a successful response, click **Save**.

Chrome's built-in PDF viewer is isolated from the extension. Use the ContentCore PDF Reader for PDFs.

## 11. Files and their roles

- `backend/app.py`: FastAPI application with `POST /define` and `GET /health`.
- `backend/config.py`: Resolves backend provider credentials and deployment settings.
- `backend/schemas.py`: Validates request and response data.
- `backend/prompts.py`: Contains the LLM instructions.
- `backend/services/llm_service.py`: Calls the configured LLM provider.
- `backend/exceptions.py`: Defines backend error responses.
- `backend/requirements.txt`: Python dependencies.
- `extension/manifest.json`: Browser extension configuration.
- `extension/popup.html`: Backend endpoint and optional backend-auth settings page.
- `extension/popup.js`: Saves extension settings locally.
- `extension/content.js`: Webpage selection, context extraction, lookup, caching, and Save.
- `extension/pdf-viewer.html`: Dedicated PDF reader page.
- `extension/pdf-reader.js`: PDF rendering, PDF text selection, lookup, and Save.
- `extension/lib/pdfjs/`: Bundled PDF.js files.

## 12. Git workflow for the team

Before starting work:

```bash
git fetch origin
git switch dev-2
git merge origin/main
```

After making changes:

```bash
git status
git add .
git commit -m "Describe the change"
git push origin dev-2
```

Do not add secrets, `.env` files, virtual environments, or `node_modules` to Git.
