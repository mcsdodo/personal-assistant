"""Mock Paperless MCP tool server for POC validation."""

import logging
from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("mock-paperless")

mcp = FastMCP("mock-paperless")


@mcp.tool()
def mock_upload(document_name: str, tags: list[str]) -> str:
    """Upload a document to Paperless (mock).

    Args:
        document_name: Name of the document to upload
        tags: List of tags to apply (e.g. ["2026-03", "invoicing", "alza"])
    """
    log.info("UPLOAD: '%s' with tags %s", document_name, tags)
    return f"Uploaded '{document_name}' with tags {tags}. Document ID: 42."


@mcp.tool()
def mock_search(query: str) -> list[dict]:
    """Search documents in Paperless (mock).

    Args:
        query: Search query string
    """
    log.info("SEARCH: '%s'", query)
    return [
        {"id": 1, "title": "Alza FA2026020045", "tags": ["2026-02", "invoicing", "alza"], "amount": "47.50 EUR"},
        {"id": 2, "title": "Orange 02/2026", "tags": ["2026-02", "invoicing", "orange"], "amount": "29.99 EUR"},
        {"id": 3, "title": "DigitalOcean Feb 2026", "tags": ["2026-02", "invoicing", "digitalocean"], "amount": "12.00 USD"},
    ]


@mcp.tool()
def mock_match_invoices(month: str) -> dict:
    """Run invoice matching for a given month (mock).

    Args:
        month: Month in YYYY-MM format
    """
    log.info("MATCH: month=%s", month)
    return {
        "month": month,
        "total_movements": 15,
        "matched": 12,
        "skipped": 2,
        "unmatched": 1,
        "unmatched_details": [
            {"date": f"{month}-15", "description": "SEPA platba XYZ", "amount": -125.00}
        ],
    }


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=8000)
