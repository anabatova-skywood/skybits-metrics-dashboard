# Skybits — Product Metrics Dashboard

A static dashboard of Skybits product metrics from **Datadog RUM** (`skybits.ai`, `env:prod`),
deployed to **GitHub Pages** and auto-refreshed on a schedule.

## How it works

```
GitHub Action (hourly cron)
  → runs scripts/fetch-metrics.mjs
  → queries the Datadog RUM Analytics API
  → writes data.json
  → deploys the static site to GitHub Pages
```

The page (`index.html`) is fully static and loads `data.json` in the browser.
**No Datadog keys are ever exposed** — the API calls happen only inside the GitHub Action.

## What's on it

- **KPIs (last 30d):** unique users, total sessions, avg sessions/user, top country
- **Top pages by visits**
- **Sessions by country** (doughnut)
- **Top 10 user actions**
- **New users per day** and **DAU / MAU stickiness** (all available RUM history;
  currently ~5 days — the window grows toward 3 months as history accumulates)

## One-time setup

1. **Create a GitHub repo** and push this folder to the `main` branch.
2. **Add repository secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `DD_API_KEY` — Datadog API key
   - `DD_APP_KEY` — Datadog Application key (needs RUM read scope)
   - `DD_SITE` — your Datadog site host, e.g. `datadoghq.com`, `datadoghq.eu`, `us3.datadoghq.com`
3. **Enable Pages:** Settings → Pages → Build and deployment → Source = **GitHub Actions**.
4. **Run it:** Actions tab → "Refresh dashboard data & deploy" → **Run workflow** (or wait for the next hour).
   The deploy URL appears in the workflow summary, e.g. `https://<user>.github.io/<repo>/`.
5. **Share that URL** with colleagues.

> The repo / Pages site is **public by default**. These metrics are aggregate product
> numbers (no PII beyond opaque RUM user IDs), but if you need access control, use a
> private repo with GitHub Pages on a paid plan, or host behind an auth proxy.

## Refresh interval

Edit the `cron` in `.github/workflows/refresh.yml`:

- `0 * * * *` — hourly (default)
- `*/15 * * * *` — every 15 minutes
- `0 */6 * * *` — every 6 hours

## Local testing

```bash
DD_API_KEY=... DD_APP_KEY=... DD_SITE=datadoghq.com node scripts/fetch-metrics.mjs
python3 -m http.server 8000   # then open http://localhost:8000
```
