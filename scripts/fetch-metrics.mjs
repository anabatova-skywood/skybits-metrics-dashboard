#!/usr/bin/env node
/**
 * Rebuilds data.json from Datadog RUM.
 * Run by the scheduled GitHub Action (and locally for testing).
 *
 * Required env:
 *   DD_API_KEY   - Datadog API key
 *   DD_APP_KEY   - Datadog Application key (RUM read scope)
 *   DD_SITE      - Datadog site host (e.g. us5.datadoghq.com)
 *
 * The RUM aggregate endpoint expects the attributes (compute/filter/group_by)
 * at the top level of the body, with epoch-millisecond from/to.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE = process.env.DD_SITE || "datadoghq.com";
const API_KEY = process.env.DD_API_KEY;
const APP_KEY = process.env.DD_APP_KEY;
const ENV = process.env.DD_ENV || "prod";
const WINDOW_DAYS = 30;
const HISTORY_DAYS = 90;
const DAY = 86400000;

if (!API_KEY || !APP_KEY) {
  console.error("Missing DD_API_KEY / DD_APP_KEY env vars.");
  process.exit(1);
}

const URL = `https://api.${SITE}/api/v2/rum/analytics/aggregate`;
const SESSIONS = `@type:session env:${ENV}`;

async function aggregate({ query, compute, groupBy = [], from, to }) {
  const body = { compute, filter: { query, from, to }, group_by: groupBy };
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": API_KEY,
      "DD-APPLICATION-KEY": APP_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Datadog ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (process.env.DD_DEBUG) console.error("DEBUG " + query + " :: " + JSON.stringify(json).slice(0, 800));
  return json.data?.buckets || [];
}

const val = (b, key) => Number(b?.computes?.[key] ?? 0);

async function main() {
  const now = Date.now();
  const win = now - WINDOW_DAYS * DAY;
  const hist = now - HISTORY_DAYS * DAY;

  // KPIs (30d): unique users + sessions
  const [kpi] = await aggregate({
    query: SESSIONS,
    from: win,
    to: now,
    compute: [
      { aggregation: "cardinality", metric: "@usr.id", type: "total" },
      { aggregation: "cardinality", metric: "@session.id", type: "total" },
    ],
  });
  const uniqueUsers = val(kpi, "c0");
  const totalSessions = val(kpi, "c1");

  // Sessions by country
  const sessionsByCountry = (await aggregate({
    query: SESSIONS,
    from: win,
    to: now,
    compute: [{ aggregation: "count", type: "total" }],
    groupBy: [{ facet: "@geo.country", limit: 20, total: false }],
  }))
    .map((b) => ({ country: b.by["@geo.country"], sessions: val(b, "c0") }))
    .sort((a, b) => b.sessions - a.sessions);

  // Top pages
  const topPages = (await aggregate({
    query: `@type:view env:${ENV}`,
    from: win,
    to: now,
    compute: [{ aggregation: "count", type: "total" }],
    groupBy: [{ facet: "@view.url_path", limit: 10, total: false }],
  }))
    .map((b) => ({ path: b.by["@view.url_path"], visits: val(b, "c0") }))
    .sort((a, b) => b.visits - a.visits);

  // Top user actions
  const topActions = (await aggregate({
    query: `@type:action env:${ENV}`,
    from: win,
    to: now,
    compute: [{ aggregation: "count", type: "total" }],
    groupBy: [{ facet: "@action.target.name", limit: 10, total: false }],
  }))
    .map((b) => ({ name: b.by["@action.target.name"] || "(unnamed)", count: val(b, "c0") }))
    .sort((a, b) => b.count - a.count);

  // Time series: per-day distinct users. One query per day over the history window
  // gives us the active-user set per day, from which we derive DAU, new users, and MAU.
  const dayUsers = new Map(); // 'YYYY-MM-DD' -> Set(userId)
  const firstDay = Math.floor(hist / DAY);
  const lastDay = Math.floor(now / DAY);
  for (let d = firstDay; d <= lastDay; d++) {
    const start = d * DAY;
    const end = start + DAY;
    const buckets = await aggregate({
      query: SESSIONS,
      from: start,
      to: end,
      compute: [{ aggregation: "count", type: "total" }],
      groupBy: [{ facet: "@usr.id", limit: 1000, total: false }],
    });
    const users = new Set(buckets.map((b) => b.by["@usr.id"]).filter(Boolean));
    if (users.size) dayUsers.set(new Date(start).toISOString().slice(0, 10), users);
  }

  const firstSeen = new Map();
  for (const [day, users] of dayUsers) {
    for (const u of users) if (!firstSeen.has(u) || day < firstSeen.get(u)) firstSeen.set(u, day);
  }

  const days = [...dayUsers.keys()].sort();
  const newUsers = [], dau = [], mau = [], stickiness = [];
  for (const day of days) {
    const users = dayUsers.get(day);
    newUsers.push([...users].filter((u) => firstSeen.get(u) === day).length);
    dau.push(users.size);
    const cutoff = new Date(new Date(day).getTime() - 29 * DAY).toISOString().slice(0, 10);
    const window = new Set();
    for (const [d2, set] of dayUsers) if (d2 >= cutoff && d2 <= day) set.forEach((u) => window.add(u));
    mau.push(window.size);
    stickiness.push(window.size ? +(users.size / window.size).toFixed(2) : 0);
  }

  const topCountry = sessionsByCountry[0] || { country: "—", sessions: 0 };

  const data = {
    meta: {
      title: "Skybits — Product Metrics",
      subtitle: "Production environment · Powered by Datadog RUM",
      env: ENV,
      application: "skybits.ai",
      updated: new Date().toISOString(),
      window_days: WINDOW_DAYS,
      history_from: days[0] || null,
      history_to: days[days.length - 1] || null,
    },
    kpis: {
      unique_users: uniqueUsers,
      total_sessions: totalSessions,
      avg_sessions_per_user: uniqueUsers ? +(totalSessions / uniqueUsers).toFixed(1) : 0,
      top_country: { name: topCountry.country, sessions: topCountry.sessions },
    },
    top_pages: topPages,
    sessions_by_country: sessionsByCountry,
    top_actions: topActions,
    timeseries: { days, new_users: newUsers, dau, mau, stickiness },
  };

  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "data.json");
  await writeFile(out, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote data.json — ${uniqueUsers} users, ${totalSessions} sessions, ${days.length} active days.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
