"""E2E: drop a PDF in the gdrive watch folder, expect a Paperless doc.

Prerequisites:
  - Local compose stack running with ``--profile local``
  - Gmail OAuth token valid and authorised with the ``drive`` scope in
    addition to ``gmail.send`` (re-run auth if token predates the drive scope).
  - GDRIVE_ROOT / GDRIVE_OWNERS / GDRIVE_BUCKETS set in the local ``.env`` file.
    (GDRIVE_LEVEL1 / GDRIVE_LEVEL2 are still accepted as legacy fallbacks.)
  - The watch folder hierarchy must exist in Google Drive.  When GDRIVE_ROOT is
    set the expected structure is ``{GDRIVE_ROOT}/{owner}/{bucket}`` (3-level),
    e.g. ``_documents_intake_dev/techlab/accounting`` and
    ``_documents_intake_dev/personal/accounting``.

The business-owner test (``test_gdrive_scan_uploads_to_paperless``) uploads a
uniquely-named PDF to the first configured owner/bucket, waits up to 5 minutes
for the gdrive-poller to pick it up and push it to Paperless, then verifies
that the file moved from the watch folder root into the ``processed/``
subfolder.

The personal-owner test (``test_gdrive_scan_personal_owner``) runs the same
flow against the ``personal`` owner folder and verifies that Paperless receives
the doc tagged ``personal`` with a ``Personal Invoices`` storage path (no
``accounting`` tag).

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
    paperless_ensure_storage_paths,
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

    # 3. Verify the file moved to processed/ and is no longer in the watch root.
    # The move happens after Paperless upload + custom fields, so the job may
    # still be running when the doc first appears in Paperless. Retry for up to
    # 90s to let the job finish.
    move_deadline = time.time() + 90
    moved = False
    while time.time() < move_deadline:
        files_in_watch = drive_client.list_files(watch_folder_id)
        if unique_filename not in [f["name"] for f in files_in_watch]:
            moved = True
            break
        time.sleep(5)
    assert moved, (
        f"'{unique_filename}' still in watch folder root after 90s — "
        "should have been moved to processed/"
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


@pytest.mark.gdrive
def test_gdrive_scan_personal_owner(reset_pipeline, personal_drive_client):
    """A PDF placed in the personal-owner watch folder should reach Paperless
    tagged ``personal`` with a ``Personal Invoices`` storage path.

    Requires ``_documents_intake_dev/personal/accounting`` (or equivalent root-
    less ``personal/accounting``) to exist in Drive and the gdrive-poller to be
    configured with ``techlab`` as the business label (``OWNER_BUSINESS_LABEL``).

    Verifies (task 96 — B2/B3 fixes):
    - Paperless doc has ``personal`` tag
    - Paperless doc does NOT have the ``accounting`` tag (personal invoices are
      not business expenses — the accounting tag is only emitted for the business
      owner role)
    - ``storage_path_name`` is ``Personal Invoices`` (not None — the B3 enum
      fail-loud guard confirms the storage path exists before upload)
    """
    assert TEST_PDF.exists(), f"Test fixture PDF not found: {TEST_PDF}"

    # Ensure both business and personal storage paths exist in Paperless
    paperless_ensure_storage_paths()

    # 1. Upload to the personal-owner bucket
    unique_filename = f"{GDRIVE_TEST_FILENAME_PREFIX}personal-{uuid.uuid4().hex[:8]}.pdf"
    watch_folder_id = personal_drive_client.resolve_watch_folder_id()
    personal_drive_client.upload_file(
        file_path=TEST_PDF,
        filename=unique_filename,
        parent_folder_id=watch_folder_id,
    )

    # 2. Poll Paperless for up to 5 minutes
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

    # 3. Verify owner tags: must have 'personal', must NOT have 'accounting'
    doc = paperless_get_document(found_doc["id"])
    tag_names = doc.get("tag_names", [])
    assert "personal" in tag_names, (
        f"Expected 'personal' tag; got tags: {tag_names}"
    )
    assert "accounting" not in tag_names, (
        f"'accounting' tag must NOT appear on personal-owner docs; got tags: {tag_names}"
    )

    # 4. Verify storage path (Personal Invoices — B3 guard ensures it exists)
    storage_path = doc.get("storage_path_name")
    assert storage_path == "Personal Invoices", (
        f"Expected storage_path_name='Personal Invoices'; got '{storage_path}'. "
        "Ensure the storage path was created in Paperless (paperless_ensure_storage_paths)."
    )

    # 5. Verify file moved to processed/
    move_deadline = time.time() + 90
    moved = False
    while time.time() < move_deadline:
        files_in_watch = personal_drive_client.list_files(watch_folder_id)
        if unique_filename not in [f["name"] for f in files_in_watch]:
            moved = True
            break
        time.sleep(5)
    assert moved, (
        f"'{unique_filename}' still in personal watch folder after 90s — "
        "should have been moved to processed/"
    )
