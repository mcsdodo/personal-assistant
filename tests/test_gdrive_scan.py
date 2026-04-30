"""E2E: drop a PDF in the gdrive watch folder, expect a Paperless doc.

Prerequisites:
  - Local compose stack running with ``--profile local``
  - Gmail OAuth token valid and authorised with the ``drive`` scope in
    addition to ``gmail.send`` (re-run auth if token predates the drive scope).
  - GDRIVE_LEVEL1 and GDRIVE_LEVEL2 set in the local ``.env`` file.
  - The watch folder hierarchy (LEVEL1/LEVEL2) must exist in Google Drive.

The test uploads a uniquely-named PDF to the resolved watch folder via the
Drive API, then waits up to 5 minutes for the gdrive-poller to pick it up
and push it to Paperless.  After the document appears in Paperless the test
verifies that the original file moved from the watch folder root into the
``processed/`` subfolder.

Known limitation: ``reset_pipeline`` (conftest.py) wipes emails.db,
workflow.db, and gdrive.db but does NOT separately reset the gdrive-poller's
in-memory poll state.  If the poller is in a backoff window when the test
runs, the pick-up latency may exceed 5 minutes on a freshly-restarted stack.
Consider extending the timeout or waiting for the first healthy poll before
uploading.
"""

import os
import time
import uuid
from pathlib import Path

import pytest

from .helpers import (
    paperless_search_documents,
    paperless_get_document,
)

GDRIVE_TEST_FILENAME_PREFIX = "e2e-gdrive-scan-"

TEST_PDF = Path(__file__).parent / "test_data" / "invoice.pdf"


@pytest.mark.gdrive
def test_gdrive_scan_uploads_to_paperless(reset_pipeline, drive_client):
    """A PDF placed in the watch folder should reach Paperless within 5 minutes."""
    assert TEST_PDF.exists(), f"Test fixture PDF not found: {TEST_PDF}"

    # 1. Upload a fresh test PDF to the watch folder
    unique_filename = f"{GDRIVE_TEST_FILENAME_PREFIX}{uuid.uuid4().hex[:8]}.pdf"
    watch_folder_id = drive_client.resolve_watch_folder_id()
    drive_client.upload_file(
        file_path=TEST_PDF,
        filename=unique_filename,
        parent_folder_id=watch_folder_id,
    )

    # 2. Poll Paperless for up to 5 minutes for a doc with our filename as title
    deadline = time.time() + 5 * 60
    found_doc = None
    while time.time() < deadline:
        results = paperless_search_documents(query=unique_filename)
        if results:
            found_doc = results[0]
            break
        time.sleep(10)

    assert found_doc is not None, (
        f"Paperless never received doc for '{unique_filename}'. "
        "Check gdrive-watcher logs and workflow-mcp jobs."
    )

    # 3. Verify the file moved to processed/ and is no longer in the watch root
    files_in_watch = drive_client.list_files(watch_folder_id)
    assert unique_filename not in [f["name"] for f in files_in_watch], (
        f"'{unique_filename}' still in watch folder root — should have been moved to processed/"
    )

    processed_folder_id = drive_client.resolve_subfolder_id(watch_folder_id, "processed")
    assert processed_folder_id is not None, (
        "processed/ subfolder not found under watch folder — "
        "gdrive-watcher may not have created it yet"
    )
    files_in_processed = drive_client.list_files(processed_folder_id)
    assert unique_filename in [f["name"] for f in files_in_processed], (
        f"'{unique_filename}' not found in processed/ subfolder"
    )
