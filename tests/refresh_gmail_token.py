"""One-shot Gmail OAuth refresh for the E2E test suite.

The E2E pipeline tests (`tests/test_email_*.py`) send emails via the Gmail API,
using a Desktop-app OAuth token cached at `config/token.json`. When that token's
refresh token expires (Google revokes after ~6 months of inactivity, or on
explicit revocation), `helpers.gmail_service()` raises `RefreshError` and every
sending test fails with the same error.

This script forces a fresh consent flow:

1. Reads the OAuth client (Desktop app) from `config/credentials.json`.
2. Opens a browser to Google's consent page (run_local_server).
3. After the user clicks "Allow", writes the new token to `config/token.json`.

Run from the personal-assistant stack root:

    cd compose.stacks/infra/personal-assistant
    python tests/refresh_gmail_token.py

Then re-run the E2E tests as normal.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/drive",
]
CREDENTIALS_FILE = Path(os.environ.get("GOOGLE_CREDENTIALS_FILE", "config/credentials.json"))
TOKEN_FILE = Path(os.environ.get("GOOGLE_TOKEN_FILE", "config/token.json"))


def main() -> int:
    if not CREDENTIALS_FILE.exists():
        print(f"ERROR: OAuth client not found at {CREDENTIALS_FILE.resolve()}", file=sys.stderr)
        print("Set GOOGLE_CREDENTIALS_FILE or place the credentials file at the default path.", file=sys.stderr)
        return 1

    print(f"Using OAuth client: {CREDENTIALS_FILE.resolve()}")
    print("A browser window will open for Google consent.")
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
    creds = flow.run_local_server(port=0)

    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(creds.to_json())
    print(f"Token refreshed and saved to: {TOKEN_FILE.resolve()}")
    print("E2E tests can now send emails via Gmail.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
