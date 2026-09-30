"""Copy legacy encrypted SQLite credentials without exposing keys or changing IDs."""

from __future__ import annotations

import argparse
from datetime import datetime
import os
from pathlib import Path
import sqlite3

from sqlalchemy import insert, select

from backend.services.credential_service import CredentialService


def import_credentials(source: Path, target: CredentialService) -> int:
    if not source.is_file():
        raise ValueError("The source SQLite database does not exist.")
    target.initialize()
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        records = [dict(row) for row in connection.execute(
            "SELECT credential_id, token_hash, provider, model, base_url, encrypted_api_key, created_at FROM credentials"
        )]
    imported = 0
    # One transaction: a conflict or wrong encryption key rolls back the entire import.
    with target.engine.begin() as connection:
        for record in records:
            target._decrypt_api_key(record["provider"], record["encrypted_api_key"])
            existing = connection.execute(select(target.credentials).where(
                target.credentials.c.credential_id == record["credential_id"]
            )).mappings().first()
            if existing:
                if any(existing[key] != record[key] for key in record if key != "created_at"):
                    raise ValueError("Conflicting credential records; no records were imported.")
                continue
            if isinstance(record["created_at"], str):
                record["created_at"] = datetime.fromisoformat(record["created_at"])
            connection.execute(insert(target.credentials).values(**record))
            imported += 1
    return imported


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    if not os.getenv("DATABASE_URL", "").strip():
        parser.error("Set DATABASE_URL to the target PostgreSQL database first.")
    target = CredentialService()
    try:
        if target.storage_backend != "postgresql":
            parser.error("The migration target must be PostgreSQL.")
        count = import_credentials(args.source, target)
        print(f"Imported {count} encrypted credential records. Source unchanged.")
    except Exception:
        # Driver exception strings can contain connection details: don't print them.
        parser.exit(1, "Import failed. Check database access, the original encryption key, and conflicting records. No records were imported.\n")
    finally:
        target.engine.dispose()


if __name__ == "__main__":
    main()
