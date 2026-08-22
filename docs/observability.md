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

| Service | Meter | Metrics |
|--------|-------|---------|
| `email-poller` | `email-poller` | `email_watcher.emails`, `email_watcher.attachments`, `email_watcher.recent_discovered`, `email_watcher.jobs`, `email_watcher.backlog`, plus the three loud guards `email_watcher.catchup_overflow`, `email_watcher.new_cap_exceeded`, `email_watcher.search_page_full` |
| `gdrive-poller` | `gdrive-poller` | `gdrive_watcher.files`, `gdrive_watcher.last_poll_seconds_ago` |
| `pa-worker` | `invoice-worker` | `invoice_worker_*` counters |

> **The service and meter names moved; the metric names deliberately did not.** The pollers
> were split out of `claude-code` into their own containers and the meters renamed
> `email-watcher` -> `email-poller` and `gdrive-watcher` -> `gdrive-poller`, but the emitted
> series still start `email_watcher.` / `gdrive_watcher.`. That is on purpose -- dashboards
> and alert rules query the series, so renaming them would silently break both. Do not
> "tidy" the prefixes to match the service names.

> `pollers/email-poller/src/main.ts` **contains literal NUL bytes** (a composite-key
> separator written as a raw character rather than `\0`), so `file` calls it binary and
> `grep -I`, ripgrep and most editors' search skip it silently -- returning "no matches"
> rather than an error. Search it with `command grep -a`, `git grep -a`, or Python. This is
> how the meter names above were verified.

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

- [uc1a-observability.md](uc1a-observability.md)
- [troubleshooting.md](troubleshooting.md)
- [CLAUDE.md](../CLAUDE.md)
