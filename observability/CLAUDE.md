# Observability (this stack)

Local-dev Alloy / Prometheus / Loki / Grafana configs, plus the dashboards. Production
telemetry goes to the shared monitoring stack -- set `OTEL_ENDPOINT` if the host Alloy is not
reachable at `http://alloy:4317` from `claude-code`.

Metric and event tables (what each series means, its attributes, and the queries):
[../docs/uc1a-observability.md](../docs/uc1a-observability.md). The short version of which
service emits what: [../docs/observability.md](../docs/observability.md).

## Meter names moved, series names did not

The pollers were split out of `claude-code` into their own containers and their meters were
renamed `email-watcher` -> `email-poller` and `gdrive-watcher` -> `gdrive-poller`. **The
emitted series still start `email_watcher.` / `gdrive_watcher.`.**

That is deliberate. Dashboard panels and the Grafana alert rules query the **series** names,
so renaming them to match the services would break both silently -- the panels would go
blank and the alerts would stop firing rather than error. Do not tidy the prefixes.

## Editing a dashboard

Dashboard JSON lives in [dashboards/](dashboards/). In a production-style deployment they are
mounted from the persistent Grafana dashboards path, and the file provisioner picks up
changes on its own interval -- **no Grafana restart needed for a dashboard.**

**Alert rules are the exception and need a full container restart**, because provisioned
rules are create-only at startup and the provisioning-reload API returns 200 without applying
the change.

## The counters that mean something is wrong

- `invoice_worker_failed_total` is zero-seeded and labelled by `reason`. Two of its reasons
  (`invalid_input`, `schema_validation_failed`) fail **before** the email-carrying span
  exists, so the trace never captures them -- the counter and the per-incident `job.failed`
  Loki line are the only signal for those.
- `invoice_worker_missing_month_tag_total` non-zero means the `accounting_period` resolution
  chain fell all the way through and a document needs manual tagging in Paperless.
- `email_watcher.catchup_overflow`, `email_watcher.new_cap_exceeded` and
  `email_watcher.search_page_full` are the pollers' loud guards against silently dropping
  email. See [../pollers/CLAUDE.md](../pollers/CLAUDE.md).
