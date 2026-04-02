# Complete Setup Guide

This guide walks through every step needed to get the Personal Assistant stack running from scratch, including all external service configuration, OAuth app registration, and first-run authentication.

Estimated effort: 30-60 minutes depending on how many integrations you enable.

## Table of contents

- [Prerequisites](#prerequisites)
- [Step 1: Clone and configure environment](#step-1-clone-and-configure-environment)
- [Step 2: Google Cloud Console (Gmail + Drive)](#step-2-google-cloud-console-gmail--drive)
- [Step 3: Microsoft Entra (Outlook)](#step-3-microsoft-entra-outlook)
- [Step 4: Telegram bot (optional)](#step-4-telegram-bot-optional)
- [Step 5: Business identity variables](#step-5-business-identity-variables)
- [Step 6: Start the stack](#step-6-start-the-stack)
- [Step 7: Set up Paperless-ngx](#step-7-set-up-paperless-ngx)
- [Step 8: Authenticate Claude Code](#step-8-authenticate-claude-code)
- [Step 9: Authenticate Gmail](#step-9-authenticate-gmail)
- [Step 10: Authenticate Outlook](#step-10-authenticate-outlook)
- [Step 11: Pair Telegram (optional)](#step-11-pair-telegram-optional)
- [Step 12: Verify everything works](#step-12-verify-everything-works)
- [Google Drive scanning (optional)](#google-drive-scanning-optional)
- [Observability (optional)](#observability-optional)
- [Environment variable reference](#environment-variable-reference)
- [Production deployment notes](#production-deployment-notes)
- [Common issues](#common-issues)

---

## Prerequisites

You need:

- **Docker** and **Docker Compose** (v2)
- **Claude Code access** — the `claude-code` container runs an interactive Claude session
- **A Google account** — for Gmail and optionally Google Drive intake
- **A Microsoft account** — for Outlook intake (or set `OUTLOOK_ENABLED=false` to skip)

Optional:

- A Telegram account (for notifications)
- An existing Paperless-ngx instance (or use the included local one)
- An OTLP-compatible endpoint (for production observability)

---

## Step 1: Clone and configure environment

```bash
git clone https://github.com/mcsdodo/personal-assistant.git
cd personal-assistant
cp .env.example .env
```

Open `.env` in your editor. You will fill in values throughout this guide. Leave placeholders for now — each section below tells you exactly what to set.

---

## Step 2: Google Cloud Console (Gmail + Drive)

This creates the OAuth credentials that let the stack read your Gmail inbox and optionally your Google Drive.

### 2.1 Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click the project dropdown at the top and select **New Project**
3. Name it something like "Personal Assistant" and click **Create**
4. Make sure the new project is selected in the dropdown

### 2.2 Enable the Gmail API

1. Go to **APIs & Services > Library** (or search "Gmail API" in the top search bar)
2. Find **Gmail API** and click **Enable**
3. If you also want Google Drive scanning, find **Google Drive API** and enable it too

### 2.3 Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**
2. Click **Get started** (or **Configure consent screen**)
3. Select **External** as user type (unless you have a Google Workspace org and want Internal)
4. Fill in:
   - **App name**: Personal Assistant
   - **User support email**: your email
   - **Developer contact**: your email
5. Click **Save and Continue**
6. On the **Data access** ([Scopes](https://console.cloud.google.com/auth/scopes)) page, click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/drive` (only if using Drive scanning)
7. Click **Save and Continue**
8. On the **Test users** page, click **Add Users** and add **your Gmail address**
9. Click **Save and Continue**

> **Important:** While the app is in "Testing" status, only the test users you add can authenticate. This is fine for personal use. You do not need to publish the app.

### 2.4 Create OAuth credentials

1. Go to **APIs & Services > [Credentials](https://console.cloud.google.com/apis/credentials)**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Desktop app** (not Web application)
4. Name: "Personal Assistant Desktop"
5. Click **Create**
6. You will see a dialog with your **Client ID** and **Client Secret**

### 2.5 Update `.env`

```bash
GOOGLE_OAUTH_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-your-secret-here
GMAIL_EMAIL=you@gmail.com
```

### 2.6 Download `client_secret.json` (alternative method)

Instead of using the individual env vars above, you can download the full JSON credentials file:

1. On the Credentials page, click the download icon next to your OAuth client
2. Save the file as `data/gmail/client_secret.json`
3. In `.env`, set:
   ```bash
   GMAIL_CLIENT_SECRET_FILE=./data/gmail/client_secret.json
   ```

Either method works. The env vars (`GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET`) take precedence if both are set.

For production deployments where you inject secrets from a vault, you can also set the entire JSON as a single env var:
```bash
GOOGLE_CLIENT_SECRET_JSON={"installed":{"client_id":"...","client_secret":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","redirect_uris":["http://localhost"]}}
```

---

## Step 3: Microsoft Entra (Outlook)

This creates the app registration that lets the stack read your Outlook inbox using the device code flow.

If you don't use Outlook, set `OUTLOOK_ENABLED=false` in `.env` and skip to [Step 4](#step-4-telegram-bot-optional).

> **Personal Microsoft accounts and MFA:** If you use a personal Hotmail/Outlook.com account, you may hit a known Microsoft issue where the Authenticator app generates **8-digit codes** but the Azure/Entra login page asks for **6 digits**. This is a widely reported problem with no official fix. Workarounds:
>
> 1. On the login page, look for **"I can't use my Microsoft Authenticator app right now"** or **"Use another verification option"** and use SMS instead
> 2. Make sure you have SMS/email as a backup MFA method at [account.microsoft.com/security](https://account.microsoft.com/security) **before** attempting to sign into Azure
> 3. Try [portal.azure.com](https://portal.azure.com) instead of entra.microsoft.com — some users report it handles personal account auth differently
> 4. If completely locked out: sign up for a [free Azure account](https://azure.microsoft.com/free) with your personal email — the signup flow may use a different auth path that bypasses the code length mismatch
> 5. **Nuclear option:** Create a fresh Outlook.com account just for Azure, register the app there. The app registration doesn't need to live in the same account as the mailbox — any tenant can host an app that accepts personal accounts. You just need the client ID; the mailbox owner consents during the device code sign-in.

### 3.1 Register an application

1. Go to [Microsoft Entra admin center](https://entra.microsoft.com) (or the [Azure portal](https://portal.azure.com) > Microsoft Entra ID)
2. Navigate to **App registrations** (under Applications in the left sidebar)
3. Click **New registration**
4. Fill in:
   - **Name**: Personal Assistant
   - **Supported account types**: **Accounts in any organizational directory and personal Microsoft accounts** (the third option). For personal `@outlook.com` / `@hotmail.com` accounts, this is the correct choice.
   - **Redirect URI**: leave blank (device code flow does not use a redirect URI)
5. Click **Register**

### 3.2 Copy the Application ID

On the app's **Overview** page, copy the **Application (client) ID**. It looks like `12345678-abcd-1234-abcd-123456789abc`.

### 3.3 Configure API permissions

1. Go to **API permissions** in the left sidebar
2. Click **Add a permission**
3. Select **Microsoft Graph**
4. Select **Delegated permissions**
5. Search for **Mail.Read** and check it
6. Click **Add permissions**

You should now see `Mail.Read` under "Configured permissions". The "Status" column should show a green checkmark or "Granted for..." — for personal accounts, admin consent is not required.

### 3.4 Enable device code flow

1. Go to **Authentication** in the left sidebar
2. Under **Advanced settings**, set **Allow public client flows** to **Yes**
3. Click **Save**

### 3.5 Update `.env`

```bash
AZURE_CLIENT_ID=12345678-abcd-1234-abcd-123456789abc
OUTLOOK_ENABLED=true
```

For personal Microsoft accounts, the default tenant setting (`consumers`) works. If you are using a work/school account, you may need to set:
```bash
AZURE_TENANT_ID=your-tenant-id
```

---

## Step 4: Telegram bot (optional)

The Telegram integration provides two-way notifications: the assistant messages you when it processes invoices, and you can message it back to approve ambiguous items.

If you don't need notifications, skip to [Step 5](#step-5-business-identity-variables).

### 4.1 Create a bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts to choose a name and username
4. BotFather will respond with a **bot token** like `7123456789:AAH...`

### 4.2 Get your chat ID

1. Message your new bot (search for its username and click **Start**)
2. Open this URL in a browser (replace `YOUR_BOT_TOKEN` with the actual token):
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
3. Look for `"chat":{"id":123456789,...}` in the JSON response — that number is your chat ID

### 4.3 Update `.env`

```bash
TELEGRAM_BOT_TOKEN=7123456789:AAHxxx...
TELEGRAM_CHAT_ID=123456789
```

---

## Step 5: Business identity variables

These variables help the document classifier determine whether an invoice belongs to your business or is personal. The classifier looks for these identifiers on the buyer/recipient side of documents.

Update `.env` with your details:

```bash
BUSINESS_COMPANY_NAME=Your Company s.r.o.
BUSINESS_TAX_IDS=SK1234567890
BUSINESS_CRN=12345678
BUSINESS_LICENSE_PLATES=BA000AA
```

| Variable | Purpose |
|---|---|
| `BUSINESS_COMPANY_NAME` | Legal company name (fuzzy matched on documents) |
| `BUSINESS_TAX_IDS` | Tax / VAT ID. Comma-separated if you have multiple |
| `BUSINESS_CRN` | Company registration number |
| `BUSINESS_LICENSE_PLATES` | Vehicle license plates for fuel receipts and parking tickets |

If a document contains any of these identifiers, it is tagged as business. Otherwise it is tagged as personal.

If you don't have a business, set these to empty strings or dummy values — the classifier will mark everything as personal.

---

## Step 6: Start the stack

The `local` profile includes a local Paperless-ngx instance plus observability tools (Grafana, Prometheus, Loki, Alloy).

```bash
docker compose --profile local --env-file .env up --build
```

Wait for all containers to become healthy:

```bash
docker compose --profile local --env-file .env ps
```

You should see 5 core services plus the local-profile services. All core services should show `healthy` status (this can take 1-2 minutes on first start as images build).

> **Note:** On first start, the `claude-code` container will wait for all MCP servers to become healthy before starting. If you see it in a "waiting" state, check that `paperless-mcp`, `checker-mcp`, `gmail-mcp`, and `outlook-mcp` are healthy.

---

## Step 7: Set up Paperless-ngx

If you are using the **local Paperless instance** from the `local` profile:

### 7.1 Create a superuser

```bash
docker compose exec paperless python3 manage.py createsuperuser
```

Follow the prompts to set a username and password.

### 7.2 Generate an API token

1. Open `http://localhost:8010` in your browser
2. Log in with the superuser credentials you just created
3. Go to **Settings** (gear icon) > **API Tokens**
4. Click **Add Token** — a new token will be generated
5. Copy the token

### 7.3 Update `.env` and restart

```bash
PAPERLESS_URL=http://paperless:8000
PAPERLESS_API_TOKEN=your-token-here
```

> The URL uses `http://paperless:8000` (the Docker internal hostname and port), not `http://localhost:8010` (the host-mapped port). The other containers communicate with Paperless over the Docker network.

After updating `.env`, restart the stack:

```bash
docker compose --profile local --env-file .env up -d
```

**If you have an existing Paperless-ngx instance**, set `PAPERLESS_URL` to its internal address (reachable from Docker containers) and provide a valid API token. You don't need the `local` profile's Paperless services.

---

## Step 8: Authenticate Claude Code

The Claude session inside the container needs a one-time login:

```bash
docker exec -it personal-assistant-claude claude login
```

This opens a browser-based OAuth flow. After logging in, restart the container so the Claude session picks up the credentials:

```bash
docker restart personal-assistant-claude
```

Wait about 90 seconds for it to become healthy again.

---

## Step 9: Authenticate Gmail

Once the Claude container is running and healthy:

1. Attach to the Claude session:
   ```bash
   docker exec -it personal-assistant-claude tmux attach -t claude
   ```

2. In the Claude session, trigger Gmail auth by typing or pasting:
   ```
   start_google_auth
   ```

3. Claude will invoke the `start_google_auth` MCP tool. The gmail-mcp server will print an authorization URL. Open it in your browser, sign in with the Google account you configured in [Step 2](#step-2-google-cloud-console-gmail--drive), and authorize the requested scopes.

4. After authorization completes, detach from tmux with `Ctrl+B` then `D`.

5. Restart the Claude container to ensure the email-watcher picks up the new tokens:
   ```bash
   docker restart personal-assistant-claude
   ```

> **Callback URL:** In a local development setup, the OAuth callback typically redirects to `http://localhost`. In production behind a reverse proxy, you would configure a callback like `https://gmail-mcp.lan/oauth2callback` and set `GOOGLE_OAUTH_REDIRECT_URI` in `.env` accordingly.

---

## Step 10: Authenticate Outlook

The Outlook MCP uses Microsoft's device code flow — no browser redirect needed.

1. Restart the Outlook container to trigger the auth flow:
   ```bash
   docker restart personal-assistant-outlook-mcp
   ```

2. Check the container logs for the device code:
   ```bash
   docker logs personal-assistant-outlook-mcp 2>&1 | grep -A5 "device_code"
   ```
   
   You should see output like:
   ```
   To sign in, use a web browser to open https://microsoft.com/devicelogin
   and enter the code XXXXXXXX to authenticate.
   ```

3. Open the URL in your browser, enter the code, and sign in with your Microsoft account.

4. The server will automatically pick up the token — no restart needed. The token is cached in `data/outlook/token_cache.json` and refreshed automatically on expiry.

If `OUTLOOK_ENABLED=false` in `.env`, the container will start but skip authentication. You can enable it later by setting the variable to `true` and restarting.

---

## Step 11: Pair Telegram (optional)

If you configured Telegram in [Step 4](#step-4-telegram-bot-optional):

1. Open Telegram and find your bot
2. Send `/start` or any message to the bot
3. The bot's access control file (`access.json` in the data volume) will register your chat

The assistant will now send you notifications when invoices are processed, and you can approve or reject ambiguous classifications by replying.

---

## Step 12: Verify everything works

### Check service health

```bash
# All services should be healthy
docker compose --profile local --env-file .env ps

# Email watcher health endpoint
curl http://localhost:9465/health

# Email watcher metrics (should show counters)
curl http://localhost:9465/metrics
```

### Check the Claude session

```bash
# View the last 30 lines of the Claude session
docker exec personal-assistant-claude tmux capture-pane -t claude -p -S -30
```

You should see the Claude session running with the email-watcher and other channels active.

### Send a test email

1. Send an email with a PDF invoice attachment to the Gmail address you configured (`GMAIL_EMAIL`)
2. Wait 30-60 seconds for the next poll cycle
3. Check the Claude session output — you should see the email being classified
4. Check Paperless at `http://localhost:8010` — the invoice should appear with extracted metadata

### Verify Paperless connectivity

```bash
curl -H "Authorization: Token YOUR_TOKEN_HERE" \
  "http://localhost:8010/api/documents/?page_size=1"
```

---

## Google Drive scanning (optional)

The gdrive-watcher polls Google Drive folders for scanned documents (PDFs, images).

### Configure folder structure

The watcher looks for files in `GDRIVE_LEVEL1/GDRIVE_LEVEL2` folders. For example, if you set:

```bash
GDRIVE_LEVEL1=mycompany
GDRIVE_LEVEL2=invoicing,documents
```

It will watch:
- `mycompany/invoicing/`
- `mycompany/documents/`

After processing, files are moved to a `processed/` subfolder within each watched folder.

### Update `.env`

```bash
GDRIVE_LEVEL1=mycompany
GDRIVE_LEVEL2=invoicing,documents
GDRIVE_MCP_URL=http://gmail-mcp:8000/mcp
GDRIVE_POLL_INTERVAL_MS=30000
```

The Drive API access comes through the same Gmail MCP server, using the Google Drive API scope you enabled in [Step 2](#step-2-google-cloud-console-gmail--drive).

---

## Observability (optional)

### Local development

The `local` profile automatically starts a full observability stack:

| Service | URL |
|---|---|
| Grafana | `http://localhost:3001` |
| Prometheus | `http://localhost:9091` |
| Loki | `http://localhost:3101` |
| Alloy UI | `http://localhost:12345` |

Grafana comes pre-configured with dashboards for email processing metrics and Claude Code telemetry. Login is disabled by default (anonymous admin access).

### Production

Point `OTEL_ENDPOINT` in `.env` to your OTLP-compatible receiver:

```bash
OTEL_ENDPOINT=http://your-alloy-or-collector:4317
OTEL_METRIC_INTERVAL=10000
```

The email-watcher exposes a Prometheus scrape endpoint on port 9465 that your monitoring stack can scrape directly.

---

## Environment variable reference

Every variable from `.env.example` with its purpose and default.

### Required

| Variable | Purpose |
|---|---|
| `PAPERLESS_URL` | Paperless-ngx API base URL. Use Docker hostname for inter-container communication (e.g., `http://paperless:8000`) |
| `PAPERLESS_API_TOKEN` | API token from Paperless Settings > API Tokens |

### Gmail (required for email intake)

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | — | OAuth client ID from Google Cloud Console |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | OAuth client secret |
| `GMAIL_EMAIL` | — | Gmail address to watch |
| `GMAIL_SEARCH_BASE` | (empty) | Additional Gmail search filter. Use `to:you+dev@gmail.com` during development to avoid processing real mail |
| `GMAIL_CLIENT_SECRET_FILE` | `./data/gmail/client_secret.json` | Path to downloaded Google OAuth JSON (alternative to individual env vars) |
| `GOOGLE_CLIENT_SECRET_JSON` | — | Full JSON credentials as a string (alternative for production secret injection) |
| `GOOGLE_OAUTH_REDIRECT_URI` | — | Custom OAuth callback URI for production deployments |

### Outlook

| Variable | Default | Purpose |
|---|---|---|
| `AZURE_CLIENT_ID` | — | Application ID from Microsoft Entra app registration |
| `OUTLOOK_ENABLED` | `true` | Set to `false` to disable Outlook polling entirely |
| `AZURE_TENANT_ID` | `consumers` | Tenant ID. Use `consumers` for personal accounts, a specific tenant ID for work accounts |

### Telegram (optional)

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your chat ID for DM notifications |

### Business identity

| Variable | Default | Purpose |
|---|---|---|
| `BUSINESS_COMPANY_NAME` | — | Full legal company name |
| `BUSINESS_TAX_IDS` | — | Tax/VAT ID (comma-separated for multiple) |
| `BUSINESS_CRN` | — | Company registration number |
| `BUSINESS_LICENSE_PLATES` | — | Vehicle plates (comma-separated for multiple) |

### Google Drive (optional)

| Variable | Default | Purpose |
|---|---|---|
| `GDRIVE_LEVEL1` | — | Top-level Drive folder to watch |
| `GDRIVE_LEVEL2` | `invoicing,documents` | Sub-folders within LEVEL1 (comma-separated) |
| `GDRIVE_MCP_URL` | `http://gmail-mcp:8000/mcp` | MCP endpoint for Drive operations |
| `GDRIVE_POLL_INTERVAL_MS` | `30000` | Drive polling interval in milliseconds |

### Polling and timing

| Variable | Default | Purpose |
|---|---|---|
| `POLL_INTERVAL_MS` | `30000` | Email polling interval in milliseconds |
| `WORKFLOW_POLL_MS` | `2000` | Workflow job processing interval |
| `STARTUP_DELAY_MS` | `15000` | Delay before first poll after container start |
| `MAX_NEW_PER_CYCLE` | `5` | Maximum emails to process per poll cycle |
| `MAX_CATCHUP_EMAILS` | `10` | Threshold for asking user approval on catchup |

### Email filtering (optional)

| Variable | Default | Purpose |
|---|---|---|
| `EMAIL_FILTER_INCLUDE` | (empty) | Only process emails where TO contains this string |
| `EMAIL_FILTER_EXCLUDE` | (empty) | Skip emails where TO contains this string |

### Storage

| Variable | Default | Purpose |
|---|---|---|
| `PA_DATA_DIR` | `./data` | Root directory for all persistent data. Production: `/mnt/shared_configs/<stack>/` |
| `BANK_PDF_PASSWORD` | (empty) | Password for encrypted bank statement PDFs |

### Telemetry (optional)

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_ENDPOINT` | `http://alloy:4317` | OTLP gRPC endpoint |
| `OTEL_METRIC_INTERVAL` | `10000` | Metric export interval in milliseconds |

---

## Production deployment notes

### Storage

Use persistent mounted storage instead of local `./data`:

```bash
PA_DATA_DIR=/mnt/shared_configs/personal-assistant
```

This path should be a mounted NAS share or persistent volume containing:
```
/mnt/shared_configs/personal-assistant/
  claude-config/       # Claude credentials
  downloads/           # Temporary invoice downloads
  email-watcher/       # SQLite audit databases
  gdrive-watcher/      # GDrive audit database
  gmail/               # Gmail OAuth tokens
  outlook/             # Outlook token cache
```

### Reverse proxy

If running behind a reverse proxy (Caddy, Traefik, nginx), configure:

- **Gmail OAuth callback**: set `GOOGLE_OAUTH_REDIRECT_URI` to your public URL, e.g., `https://gmail-mcp.yourdomain.com/oauth2callback`
- **Checker web UI**: expose port 5000 via your proxy (e.g., `https://invoices.yourdomain.com`)
- **Gmail MCP port 8000**: only needs to be accessible from within the Docker network unless you want external OAuth callback routing

### Secrets

Never commit `.env` or `client_secret.json`. In production:
- Inject secrets via your deployment tool (Komodo, Portainer, etc.)
- Use `GOOGLE_CLIENT_SECRET_JSON` env var instead of mounting a file
- Rotate API tokens periodically

### Without the local profile

If you have your own Paperless instance and monitoring stack, start without the `local` profile:

```bash
docker compose --env-file .env up --build
```

This starts only the 5 core services. Point `PAPERLESS_URL` to your external instance and `OTEL_ENDPOINT` to your collector.

---

## Common issues

### "Gmail auth fails with redirect_uri_mismatch"

Make sure the OAuth client type is **Desktop app** (not Web application). Desktop apps use `http://localhost` as the redirect URI by default, which avoids mismatch issues in local development.

### "Outlook shows AADSTS... error"

- Verify `AZURE_CLIENT_ID` matches the Application (client) ID in Entra
- Ensure "Allow public client flows" is set to **Yes** in Authentication settings
- For personal accounts, `AZURE_TENANT_ID` should be `consumers` (the default)

### "Email watcher health returns 503"

This means no successful email poll in the last 2.5 minutes. Check:
- Gmail/Outlook auth tokens (may need re-authentication)
- Container logs: `docker logs personal-assistant-claude`
- MCP server health: `docker compose ps` (all should be `healthy`)

### "Paperless upload fails"

- Verify `PAPERLESS_URL` uses the Docker service name (`http://paperless:8000`), not `localhost`
- Verify `PAPERLESS_API_TOKEN` is valid: `curl -H "Authorization: Token YOUR_TOKEN" http://localhost:8010/api/documents/`
- Check the Paperless container logs for errors

### "Claude container keeps restarting"

- Check that all MCP dependencies are healthy first: `docker compose ps`
- View the Claude startup output: `docker logs personal-assistant-claude`
- The Claude container waits for all MCP servers to be healthy before starting (via `depends_on` health checks)

### "Google consent screen says 'unverified app'"

This is normal for apps in "Testing" status. Click **Continue** (or **Advanced > Go to Personal Assistant**). Only test users you added in the consent screen configuration can authenticate.

### Re-authenticating after token expiry

```bash
# Gmail: clear tokens and re-auth
rm -rf data/gmail/*.json
docker restart personal-assistant-claude
# Then trigger start_google_auth from the Claude session

# Outlook: clear token cache and re-auth
rm -f data/outlook/token_cache.json
docker restart personal-assistant-outlook-mcp
# Check logs for new device code
docker logs personal-assistant-outlook-mcp 2>&1 | grep -A5 "device_code"
```

---

## Next steps

- [Architecture overview](architecture.md) — understand how the services fit together
- [Invoice processing pipeline](uc1-invoice-processing.md) — detailed flow from email to Paperless
- [Invoice matching](uc2-invoice-matching.md) — bank statement matching and P&L
- [Development guide](development.md) — running tests and contributing
- [Troubleshooting](troubleshooting.md) — more debugging tips
