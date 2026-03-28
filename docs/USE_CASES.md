# Personal Assistant — Use Cases

Documentation index for all implemented functionality. Each implemented use case links to its detailed doc.

Source of truth: [`_tasks/10-personal-assistant/USE-CASES.md`](../../../../_tasks/10-personal-assistant/USE-CASES.md)

## UC-1: Invoice Processing (email → Paperless)

[Detailed documentation](./uc1-invoice-processing.md)

| # | Use Case | Status |
|---|----------|--------|
| 1.1 | [Auto-download invoice from Gmail](./uc1-invoice-processing.md#uc-11-gmail-polling) | DONE |
| 1.2 | [Auto-download invoice from Outlook](./uc1-invoice-processing.md#uc-12-outlook-polling) | DONE |
| 1.3 | [Classify and tag invoice](./uc1-invoice-processing.md#uc-13-classification) | DONE |
| 1.4 | [Upload invoice to Paperless-ngx](./uc1-invoice-processing.md#uc-14-upload-to-paperless) | DONE |
| 1.5 | [Notify on new invoice](./uc1-invoice-processing.md#uc-15-telegram-notification) | DONE |
| 1.6 | [Alert on unknown vendor / unusual amount](./uc1-invoice-processing.md#uc-16-approval-gates) | DONE |
| 1.7 | [Query invoice status](./uc1-invoice-processing.md#uc-17-query-invoice-status) | DONE |
| 1.8 | GDrive scan auto-upload (scan → GDrive → classify → Paperless) | DONE |

## UC-1A: Email Workflow Observability

[Detailed documentation](./uc1a-observability.md)

| # | Use Case | Status |
|---|----------|--------|
| 1A.1 | [Inbox backlog by source/status](./uc1a-observability.md#uc-1a1-inbox-backlog) | DONE |
| 1A.2 | [Track attachment-bearing emails](./uc1a-observability.md#uc-1a2-attachment-tracking) | DONE |
| 1A.3 | [Track workflow actions](./uc1a-observability.md#uc-1a3-workflow-actions) | DONE |
| 1A.4 | [Track vendor mix](./uc1a-observability.md#uc-1a4-vendor-mix) | DONE |
| 1A.5 | [Track confidence and latency](./uc1a-observability.md#uc-1a5-confidence-and-latency) | DONE |
| 1A.6 | [Track Claude token/cost](./uc1a-observability.md#uc-1a6-claude-telemetry) | DONE |

## UC-2: Invoice Matching & Accountant

[Detailed documentation](./uc2-invoice-matching.md)

| # | Use Case | Status |
|---|----------|--------|
| 2.1 | [Match invoices against bank statement](./uc2-invoice-matching.md#uc-21-match-invoices) | DONE |
| 2.2 | [Report mismatches / missing invoices](./uc2-invoice-matching.md#uc-22-report-mismatches) | DONE |
| 2.3 | Generate monthly ZIP for accountant | -- |
| 2.4 | Draft accountant email with ZIP | -- |
| 2.5 | Send email after user approval | -- |
| 2.6 | Month-end auto-check (cron) | -- |
| 2.7 | [P&L annual summary](./uc2-invoice-matching.md#uc-27-pl-summary) | DONE |

## UC-3: Vehicle Logbook

Not implemented.

## UC-4: Attendance & Business Trips

Not implemented.

## UC-5: Cross-App Workflows

Not implemented.

## Infrastructure & Non-Functional

[Detailed documentation](./infrastructure.md)

| Component | Status |
|-----------|--------|
| [Docker build & image](./infrastructure.md#docker-build) | DONE |
| [Komodo deployment](./infrastructure.md#komodo-deployment) | DONE |
| [Authentication flows](./infrastructure.md#authentication) | DONE |
| [Health checks](./infrastructure.md#health-checks) | DONE |
| [Restart resilience](./infrastructure.md#restart-resilience) | DONE |
| [Stateless MCP sessions](./infrastructure.md#stateless-mcp) | DONE |
| [NAS-backed persistence](./infrastructure.md#persistence) | DONE |
| [Watchtower exclusion & version pinning](./infrastructure.md#version-management) | DONE |
