# Observability

The stack exposes both workflow-specific metrics and native Claude Code telemetry.

## Local profile

The `local` profile starts:

- Alloy
- Prometheus
- Loki
- Grafana

Typical local endpoints:

| Service | URL |
|---|---|
| Grafana | `http://localhost:3001` |
| Prometheus | `http://localhost:9091` |
| Loki | `http://localhost:3101` |
| Alloy UI | `http://localhost:12345` |

## Data sources

### Watcher and worker metrics (OTLP push)

All workflow metrics are pushed via OTLP from each container; there is no
`/metrics` scrape endpoint. The `:9465` port on `email-watcher` exposes
`/health` only.

| Source | Meter | Metrics |
|--------|-------|---------|
| `email-watcher` | `email-watcher` | `email_watcher.emails`, `email_watcher.attachments`, `email_watcher.recent_discovered`, `email_watcher.jobs`, `email_watcher.backlog` |
| `gdrive-watcher` | `gdrive-watcher` | `gdrive_watcher.files`, `gdrive_watcher.last_poll_seconds_ago` |
| `workflow-mcp` (invoice worker) | `invoice-worker` | `invoice_worker_correspondents_total`, `invoice_worker_missing_month_tag_total` |

See [`uc1a-observability.md`](uc1a-observability.md) for the full table with
attributes, types, and queries.

### Claude Code telemetry

Claude Code can export OTLP telemetry to the endpoint configured by `OTEL_ENDPOINT`.

Public docs use a placeholder such as `YOUR_OTEL_ENDPOINT` or `http://alloy:4317`.

## Production-style deployments

For a production-like deployment you can:

- point `OTEL_ENDPOINT` to your own OTLP receiver
- mount dashboard JSON files from your persistent config path

Public docs intentionally avoid prescribing one specific homelab layout.

## Related docs

- `docs/uc1a-observability.md`
- `docs/troubleshooting.md`
- `CLAUDE.md`
