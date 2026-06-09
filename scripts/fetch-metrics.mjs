#!/usr/bin/env node
/**
 * Rebuilds data.json from Datadog RUM.
 * Run by the scheduled GitHub Action (and locally for testing).
 *
 * Required env:
 *   DD_API_KEY   - Datadog API key
 *   DD_APP_KEY   - Datadog Application key
 *   DD_SITE      - Datadog site host (default: datadoghq.com)
 *
 * Mirrors the queries used to build the original snapshot:
 *   app = skybits.ai, env = prod.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE = process.env.DD_SITE || "datadoghq.com";
const API_KEY = process.env.DD_API_KEY;
const APP_KEY = process.env.DD_APP_KEY;
const ENV = process.env.DD_ENV || "prod";
const WINDOW_DAYS = 30;

if (!API_KEY || !APP_KEY) {
  console.error("Missing DD_API_KEY / DD_APP_KEY env vars.");
  process.exit(1);
}

const BASE = `https://api.${SITE}/api/v2/rum/analytics/aggregate`;
const BASE_FILTER = `@type:session env:${ENV}`;

async function aggregate({ query, compute, groupBy = [], from = `now-${WINDOW_DAYS}d`, to = "now" }) {
  const body = {
    data: {
      type: "aggregate_request",
      attributes: { compute, filter: { query, from, to }, group_by: groupBy },
    },
  };
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": API_KEY,
      "DD-APPLICATION-KEY": APP_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Datadog ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data?.buckets || [];
}

const num = (b, key) => Number(b?.computes?.[key] ?? 0);

async function main() {
  // --- KPIs (last 30d) ---
  const kpiBuckets = await aggregate({
    query: BASE_FILTER,
    compute: [
      { aggregation: "cardinality", metric: "@usr.id", type: "total" },
      { aggregation: "cardinality", metric: "@session.id", type: "total" },
    ],
  });
  const kpi = kpiBuckets[0] || { computes: {} };
  const uniqueUsers = num(kpi, "c0");
  const totalSessions = num(kpi, "c1");

  // --- Sessions by country ---
  const countryBuckets = await aggregate({
    query: BASE_FILTER,
    compute: [{ aggregation: "count", type: "total" }],
    groupBy: [{ facet: "@geo.country", limit: 20, sort: { aggregation: "count", order: "desc" } }],
  });
  const sessionsByCountry = countryBuckets
    .map((b) => ({ country: b.by["@geo.country"], sessions: num(b, "c0") }))
    .sort((a, b) => b.sessions - a.sessions);

  // --- Top pages (views) ---
  const pageBuckets = await aggregate({
    query: `@type:view env:${ENV}`,
    compute: [{ aggregation: "count", type: "total" }],
    groupBy: [{ facet: "@view.url_path", limit: 10, sort: { aggregation: "count", order: "desc" } }],
  });
  const topPages = pageBuckets
    .map((b) => ({ path: b.by["@view.url_path"], visits: num(b, "c0") }))
    .sort((a, b) => b.visits - a.visits);

  // --- Top user actions ---
  const actionBuckets = await aggregate({
    query: `@type:action env:${ENV}`,
    compute: [{ aggregation: "count", type: "total" }],
    groupBy: [{ facet: "@action.target.name", limit: 10, sort: { aggregation: "count", order: "desc" } }],
  });
  const topActions = actionBuckets
    .map((b) => ({ name: b.by["@action.target.name"] || "(unnamed)", count: num(b, "c0") }))
    .sort((a, b) => b.count - a.count);

  // --- Time series: per-day per-user, last 90d (window extends as history grows) ---
  const tsBuckets = await aggregate({
    query: BASE_FILTER,
    from: "now-90d",
    compute: [{ aggregation: "count", type: "timeseries", interval: "1d" }],
    groupBy: [{ facet: "@usr.id", limit: 1000 }],
  });

  // Flatten timeseries buckets -> { day -> Set(userId) }
  const dayUsers = new Map();
  const firstSeen = new Map();
  for (const b of tsBuckets) {
    const user = b.by["@usr.id"];
    const series = b.computes?.c0?.buckets || b.computes?.c0 || [];
    const points = Array.isArray(series) ? series : [];
    for (const pt of points) {
      const count = Array.isArray(pt) ? pt[1] : pt.value;
      if (!count) continue;
      const ts = Array.isArray(pt) ? pt[0] : pt.time;
      const day = new Date(ts).toISOString().slice(0, 10);
      if (!dayUsers.has(day)) dayUsers.set(day, new Set());
      dayUsers.get(day).add(user);
      if (!firstSeen.has(user) || day < firstSeen.get(user)) firstSeen.set(user, day);
    }
  }

  const days = [...dayUsers.keys()].sort();
  const newUsers = [], dau = [], mau = [], stickiness = [];
  const seen = new Set();
  for (const day of days) {
    const users = dayUsers.get(day);
    let nu = 0;
    for (const u of users) if (firstSeen.get(u) === day) nu++;
    newUsers.push(nu);
    dau.push(users.size);
    // MAU = distinct users in trailing 30d up to and including this day
    const cutoff = new Date(new Date(day).getTime() - 29 * 86400000).toISOString().slice(0, 10);
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
  console.log(`Wrote ${out} — ${uniqueUsers} users, ${totalSessions} sessions, ${days.length} days of history.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
