# Persistent user credentials

The existing `credential_id` is a randomly generated, unique ID for a user's
saved provider connection. The browser keeps this ID and an access token in
`chrome.storage.local`, which survives browser restarts. The provider API key
is stored only in the backend database, encrypted with AES-256-GCM. The database
stores a SHA-256 hash of the access token, not the token itself.

The flow is:

1. The user enters a provider key once. `POST /credentials` verifies it and stores it.
2. The backend returns an ID and a random access token; the extension saves them.
3. Web and PDF lookups send that ID/token to `POST /define`.
4. The backend authenticates the token, reads the matching database row, decrypts
   the provider key, and calls the provider. It never returns the provider key.

An ID alone is not authorization. This is a browser-profile identity, not an
email/password account: using another browser or uninstalling the extension
requires registering again. Normal browser sessions do not.

## Render setup for the existing service

1. Create a **Render PostgreSQL** database in the same region as `arthfind-backend`.
   Choose a paid database for deployment: Render's free databases expire after
   30 days. The included Blueprint selects the smallest paid database plan.
2. In the backend service's Environment settings, set `DATABASE_URL` to that
   database's **Internal Database URL**.
3. Set `CREDENTIAL_ENCRYPTION_KEY` to a permanent base64-encoded 32-byte secret.
   If preserving existing credentials, use their original encryption key exactly.
   Do not change or regenerate this key on each deployment.
4. Deploy this code using `pip install -r backend/requirements.txt` and
   `uvicorn backend.app:app --host 0.0.0.0 --port $PORT` from the repository root.
   Startup creates the credentials table automatically and rejects missing
   encryption or database configuration. It does not fall back to SQLite on Render.
5. Check `/health`: `credential_storage_backend` should be `postgresql` and
   `credential_storage_configured` should be `true`.
6. Register a test key once, close and reopen the browser, and restart the backend.
   A new uncached lookup should continue working without re-entering that key.

Alternatively, apply the root `render.yaml` as a Render Blueprint after reviewing
its resource names and billing. For an existing service, preserve the current
encryption key in its environment **before** applying the Blueprint. `generateValue`
only creates a value if that environment variable does not already exist.
Keep the web service and database in the same region.

These files prepare the deployment; they do not create a cloud database by themselves.
Back up both PostgreSQL and the encryption key. A database backup without that key
cannot recover stored provider credentials.

## Existing SQLite credentials

To preserve IDs already saved in users' browsers, copy the original SQLite file
while it is still available, set the target `DATABASE_URL` and the **same**
`CREDENTIAL_ENCRYPTION_KEY`, then run from the repository root:

```sh
python -m backend.migrate_credentials --source /path/to/.credentials.sqlite3
```

The import checks decryption, preserves IDs and token hashes, skips identical
records, and refuses to overwrite conflicting records. It does not delete the source.
If Render already discarded the old SQLite file or encryption key, those old
connections cannot be recovered; users must register once with the new storage.

## Local development

Copy the relevant variables from `.env.example` into `backend/.env` and set an
encryption key once. Keep `DATABASE_URL` empty to reuse the existing local
`backend/.credentials.sqlite3`, or point it to a development PostgreSQL database.
The application no longer generates secrets or appends them to `.env` at runtime.

References: [Render persistence](https://render.com/docs/free),
[Render Blueprint fields](https://render.com/docs/blueprint-spec).
