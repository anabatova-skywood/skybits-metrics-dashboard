#!/usr/bin/env node
// One-shot diagnostic: find the request shape that makes group_by + filter work.
const SITE = process.env.DD_SITE || "datadoghq.com";
const API_KEY = process.env.DD_API_KEY;
const APP_KEY = process.env.DD_APP_KEY;
const H = { "Content-Type": "application/json", "DD-API-KEY": API_KEY, "DD-APPLICATION-KEY": APP_KEY };

const nowMs = Date.now();
const from30 = nowMs - 30 * 86400000;

const attrs = (fromVal, toVal) => ({
  compute: [{ aggregation: "count", type: "total" }],
  filter: { query: "@type:session", from: fromVal, to: toVal },
  group_by: [{ facet: "@geo.country", limit: 10, total: false }],
});

const variants = [
  { name: "A v2 analytics, relative", url: `https://api.${SITE}/api/v2/rum/analytics/aggregate`,
    body: { data: { type: "aggregate_request", attributes: attrs("now-30d", "now") } } },
  { name: "B v2 analytics, epoch-ms", url: `https://api.${SITE}/api/v2/rum/analytics/aggregate`,
    body: { data: { type: "aggregate_request", attributes: attrs(from30, nowMs) } } },
  { name: "C v2 events, epoch-ms", url: `https://api.${SITE}/api/v2/rum/events/aggregate`,
    body: { data: { type: "aggregate_request", attributes: attrs(from30, nowMs) } } },
  { name: "D no data-wrapper, epoch-ms", url: `https://api.${SITE}/api/v2/rum/analytics/aggregate`,
    body: attrs(from30, nowMs) },
];

for (const v of variants) {
  try {
    const res = await fetch(v.url, { method: "POST", headers: H, body: JSON.stringify(v.body) });
    const text = await res.text();
    let buckets = "n/a";
    try { buckets = (JSON.parse(text).data?.buckets || []).length; } catch {}
    console.log(`[${v.name}] HTTP ${res.status} buckets=${buckets} :: ${text.slice(0, 300)}`);
  } catch (e) {
    console.log(`[${v.name}] threw ${e}`);
  }
}
