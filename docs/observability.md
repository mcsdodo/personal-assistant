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

### Email watcher metrics

Served from `http://localhost:9465/metrics` in local development.

Key metrics include:

- `email_watcher_backlog_total`
- `email_watcher_actions_total`
- `email_watcher_confidence_total`
- `email_watcher_latency_seconds`

### Claude Code telemetry

Claude Code can export OTLP telemetry to the endpoint configured by `OTEL_ENDPOINT`.

Public docs use a placeholder such as `YOUR_OTEL_ENDPOINT` or `http://alloy:4317`.

## Production-style deployments

For a production-like deployment you can:

- scrape the email watcher metrics endpoint from your monitoring stack
- point `OTEL_ENDPOINT` to your own OTLP receiver
- mount dashboard JSON files from your persistent config path

Public docs intentionally avoid prescribing one specific homelab layout.

## Related docs

- `docs/uc1a-observability.md`
- `docs/troubleshooting.md`
- `CLAUDE.md`
