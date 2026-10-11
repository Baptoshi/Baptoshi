#!/usr/bin/env node
/**
 * Les widgets du profil GitHub, dessinés à partir des seuls chiffres que l'API rend.
 *
 * Un fichier par widget (`assets/*.svg`), posés côte à côte dans le README : une image par mesure, lisible
 * seule, plutôt qu'une planche unique où tout se serre.
 *
 * **Public seulement.** Les dépôts sont demandés en `privacy: PUBLIC` et les pull requests comptées par une
 * recherche `is:public` : avec un jeton personnel, l'API montrerait aussi les dépôts privés — leurs langages,
 * leurs tailles et leurs millésimes seraient alors publiés ici. Et même publics, ils ne sont lus qu'en
 * **agrégat** : jamais un nom, jamais un contenu, jamais une description.
 *
 *   node scripts/card.mjs            # écrit assets/*.svg
 *   GITHUB_TOKEN=… node scripts/card.mjs
 *
 * Les contributions (séries, matrice, répartition) sont celles que le profil publie : avec le réglage
 * « Include private contributions on my profile », elles comptent aussi l'activité privée, sans rien en dire.
 */

import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const LOGIN = process.env.CARD_LOGIN ?? "Baptoshi";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("card: il faut un jeton GitHub dans GITHUB_TOKEN (lecture publique suffit).");
  process.exit(2);
}

const QUERY = `query($login: String!, $prq: String!) {
  user(login: $login) {
    name login avatarUrl createdAt
    followers { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date weekday } }
      }
    }
    repositories(first: 100, privacy: PUBLIC, isFork: false, ownerAffiliations: OWNER) {
      totalCount
      nodes {
        stargazerCount forkCount createdAt diskUsage
        languages(first: 8, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
      }
    }
  }
  search(query: $prq, type: ISSUE) { issueCount }
}`;

const api = async (query, variables) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${TOKEN}`, "content-type": "application/json", "user-agent": `card/${LOGIN}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(" · "));
  return body.data;
};

const data = await api(QUERY, { login: LOGIN, prq: `author:${LOGIN} is:pr is:merged is:public` });
const user = data.user;
const c = user.contributionsCollection;
const repos = user.repositories.nodes;
const mergedPr = data.search.issueCount;
const weeksRaw = c.contributionCalendar.weeks.slice(-52);
const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);

/* ── Ce que les widgets tracent, et rien d'autre ─────────────────────────────────────────────────────── */

const active = days.filter((d) => d.contributionCount > 0).length;
const stars = repos.reduce((t, r) => t + r.stargazerCount, 0);
const forks = repos.reduce((t, r) => t + r.forkCount, 0);
const disk = repos.reduce((t, r) => t + (r.diskUsage ?? 0), 0); // Ko, tel que l'API le donne

const series = weeksRaw.map((w) => w.contributionDays.reduce((t, d) => t + d.contributionCount, 0));
const hi = Math.max(1, ...series);
let run = 0;
const cumulative = series.map((v) => (run += v));
const total = c.contributionCalendar.totalContributions;

const last7 = days.slice(-7).reduce((t, d) => t + d.contributionCount, 0);
const prev7 = days.slice(-14, -7).reduce((t, d) => t + d.contributionCount, 0);
const delta = last7 - prev7;
const up = delta >= 0;

const MIX = [
  ["COMMITS", c.totalCommitContributions],
  ["PULL REQUESTS", c.totalPullRequestContributions],
  ["ISSUES", c.totalIssueContributions],
  ["REVIEWS", c.totalPullRequestReviewContributions],
].filter(([, v]) => v > 0);
const mixTotal = Math.max(1, MIX.reduce((t, [, v]) => t + v, 0));

const byLang = new Map();
for (const r of repos) for (const e of r.languages.edges) byLang.set(e.node.name, (byLang.get(e.node.name) ?? 0) + e.size);
const langTotal = Math.max(1, [...byLang.values()].reduce((t, v) => t + v, 0));
const sorted = [...byLang.entries()].sort((a, b) => b[1] - a[1]);
const LANGS = sorted.slice(0, 5);
const rest = sorted.slice(5).reduce((t, [, v]) => t + v, 0);
if (rest > 0) LANGS.push(["OTHER", rest]);

const WD = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const weekday = WD.map((_, i) => days.filter((d) => d.weekday === (i + 1) % 7).reduce((t, d) => t + d.contributionCount, 0));
const wdHi = Math.max(1, ...weekday);

const years = [...new Set(repos.map((r) => r.createdAt.slice(0, 4)))].sort();
const vintage = years.map((y) => [y, repos.filter((r) => r.createdAt.slice(0, 4) === y).length]);
const vintageHi = Math.max(1, ...vintage.map(([, n]) => n));

const inMb = disk >= 2048; // sous deux mégaoctets, la lecture se fait en kilo-octets
const UNIT = inMb ? "MB" : "KB";
const sizes = repos.map((r) => (r.diskUsage ?? 0) / (inMb ? 1024 : 1)).sort((a, b) => b - a).slice(0, 6);
const sizeHi = Math.max(0.1, ...sizes);
const bulk = `${(disk / (inMb ? 1024 : 1)).toFixed(inMb ? 0 : 0)} ${UNIT}`;

/**
 * Les événements publics, seule source de GitHub qui porte une **heure**. L'API n'en garde que les derniers
 * (300 au plus, 90 jours au plus) : la fenêtre réellement reçue est affichée sur les cadrans, jamais extrapolée.
 * Publics par définition — c'est le flux que tout le monde peut lire sur le profil.
 */
const events = await (async () => {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`https://api.github.com/users/${LOGIN}/events/public?per_page=100&page=${page}`, {
      headers: { authorization: `bearer ${TOKEN}`, accept: "application/vnd.github+json", "user-agent": `card/${LOGIN}` },
    });
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch.map((e) => e.created_at).filter(Boolean));
    if (batch.length < 100) break;
  }
  return out;
})();

const TZ = "Europe/Paris";
const WHEN = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23", weekday: "short" });
const clock = Array.from({ length: 24 }, () => 0);
const punch = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
for (const iso of events) {
  const parts = WHEN.formatToParts(new Date(iso));
  const hour = Number(parts.find((x) => x.type === "hour")?.value ?? -1);
  const wd = WD.indexOf((parts.find((x) => x.type === "weekday")?.value ?? "").toUpperCase());
  if (hour < 0 || wd < 0) continue;
  clock[hour]++;
  punch[wd][hour]++;
}
const clockHi = Math.max(1, ...clock);
const punchHi = Math.max(1, ...punch.flat());
const window = events.length
  ? `${events[events.length - 1].slice(0, 10)} → ${events[0].slice(0, 10)}`
  : "AUCUN ÉVÉNEMENT PUBLIC";

/**
 * Les séries de jours consécutifs. La journée en cours peut n'être pas finie : une série qui s'arrête hier
 * court toujours, une série qui s'arrête avant-hier est rompue.
 */
const streaks = (() => {
  let best = 0, bestEnd = null, cur = 0, curEnd = null, run = 0, start = null;
  for (const d of days) {
    if (d.contributionCount > 0) {
      run += 1;
      start ??= d.date;
      if (run > best) { best = run; bestEnd = d.date; }
    } else {
      run = 0; start = null;
    }
  }
  // La série en cours se compte à rebours depuis le dernier jour, en tolérant une journée du jour encore vide.
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) { cur += 1; curEnd ??= days[i].date; }
    else if (i === days.length - 1) continue;
    else break;
  }
  return { best, bestEnd, cur, curEnd };
})();

/** Portrait embarqué : une image liée par URL ne se charge pas dans un SVG servi comme image. */
const avatar = await fetch(`${user.avatarUrl}&s=120`).then(async (r) => {
  if (!r.ok) return null;
  const type = r.headers.get("content-type") ?? "image/png";
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (v, t) => `${((v / t) * 100).toFixed(1)}%`;
const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";
const since = user.createdAt.slice(0, 4);

/* ── Le cadre commun : un widget est un SVG autonome (servi comme image, il n'hérite de rien) ────────── */

const FULL = 870, HALF = 428;
const RAMP = ["#00c805", "#06a830", "#0c8b3c", "#2a7248", "#45604f", "#5c6168"];
const HEAT = ["#17191d", "#0b4a22", "#0a7a31", "#00a83d", "#4dec6a"];

const STYLE = `
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .mono, .big, .val, .num { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
      .tick { font-size: 13px; fill: #fff; font-weight: 600; letter-spacing: 1.4px; }
      .sub  { font-size: 10.5px; fill: #6d7279; letter-spacing: 1.2px; }
      .sec  { font-size: 10px; fill: #e8eaed; letter-spacing: 1.8px; font-weight: 600; }
      .lab  { font-size: 9.5px; fill: #6d7279; letter-spacing: 1.5px; }
      .tiny { font-size: 8.5px; fill: #5d6268; letter-spacing: 1.1px; }
      .big  { font-size: 44px; fill: #fff; font-weight: 500; letter-spacing: -1.4px; }
      .chg  { font-size: 12.5px; fill: ${up ? "#00c805" : "#ff5000"}; font-weight: 600; }
      .key  { font-size: 9.5px; fill: #8b9199; letter-spacing: 1.3px; }
      .val  { font-size: 16px; fill: #fff; font-weight: 500; }
      .num  { font-size: 11px; fill: #c9ced4; }
      .leg  { font-size: 10px; fill: #a7adb4; letter-spacing: .6px; }
      .foot { font-size: 9px; fill: #5d6268; letter-spacing: 1.1px; }
      .live { font-size: 9.5px; fill: #00c805; letter-spacing: 1.6px; font-weight: 600; }

      .pulse { animation: pulse 2.6s ease-in-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
      .ping  { animation: ping 2.6s ease-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
      @keyframes ping { 0% { opacity: .55; transform: scale(1); } 70%, 100% { opacity: 0; transform: scale(3.4); } }
      .cellule { animation: cellule 6s ease-in-out infinite alternate; }
      @keyframes cellule { from { opacity: .5; } to { opacity: 1; } }
      .grow  { animation: grow 5.5s ease-in-out infinite alternate; }
      @keyframes grow { from { opacity: .55; } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .pulse, .ping, .cellule, .grow, .scan, .trace, .gloss, .spin, .sheen { animation: none; }
        .ping, .scan, .trace, .gloss, .sheen { opacity: 0; }
      }`;

const DEFS = `
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#00c805"/><stop offset="1" stop-color="#00c805" stop-opacity=".45"/>
    </linearGradient>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#00c805" stop-opacity=".32"/><stop offset="1" stop-color="#00c805" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="cursor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8dffa0" stop-opacity="0"/><stop offset=".45" stop-color="#8dffa0" stop-opacity=".75"/>
      <stop offset="1" stop-color="#8dffa0" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".3"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>`;

/** Un widget : son cadre, son intitulé, son filet, et ce qu'il trace. */
const widget = ({ w, h, title, note, label, desc, head: header, body, css = "", defs = "" }) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
  <title>${esc(title ?? LOGIN)}</title>
  <desc>${esc(desc)}</desc>
  <defs>${DEFS}${defs}
    <style>${STYLE}${css}
    </style>
  </defs>
  <rect width="${w}" height="${h}" rx="12" fill="#0a0a0b"/>
  <rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="11.5" fill="none" stroke="#1a1c1f"/>
${header ?? `  <text x="20" y="28" class="sec">${title}</text>
  ${note ? `<text x="${w - 20}" y="28" class="lab" text-anchor="end">${note}</text>` : ""}
  <line x1="0" y1="42" x2="${w}" y2="42" stroke="#1a1c1f"/>`}
${body}
</svg>
`;

const SOURCE = `Source : API GraphQL de GitHub, arrêté au ${stamp}. Dépôts publics seulement, lus en agrégat : ni nom, ni contenu, ni description.`;

/* ── 1. Cotation : la mesure principale, la série hebdomadaire, les chiffres clés ────────────────────── */

const FIG = [
  ["MERGED PR", mergedPr],
  ["PUBLIC REPOS", user.repositories.totalCount],
  ["LANGUAGES", byLang.size],
  ["STARS", stars],
  ["FORKS", forks],
  ["FOLLOWERS", user.followers.totalCount],
];
const bw1 = 380 / series.length;

const summary = widget({
  w: FULL, h: 212,
  title: `${user.login} — GitHub`,
  label: `${user.login} : ${total} contributions sur douze mois, ${delta >= 0 ? "+" : ""}${delta} sur sept jours ; ${FIG.map(([l, v]) => `${v} ${l.toLowerCase()}`).join(", ")}.`,
  desc: `${total} contributions sur douze mois (${up ? "+" : ""}${delta} sur sept jours contre les sept précédents), ${FIG.map(([l, v]) => `${v} ${l.toLowerCase()}`).join(", ")}. ${SOURCE}`,
  css: `
      .scan { animation: scan 9s ease-in-out infinite; }
      @keyframes scan { 0%, 100% { transform: translateX(0); opacity: 0; } 8% { opacity: 1; } 50% { transform: translateX(380px); opacity: .9; } 92% { opacity: 0; } }`,
  defs: `<clipPath id="face"><rect x="20" y="18" width="26" height="26" rx="7"/></clipPath>
    <clipPath id="plot"><rect x="470" y="64" width="380" height="84"/></clipPath>`,
  head: `  ${avatar ? `<image href="${avatar}" x="20" y="18" width="26" height="26" clip-path="url(#face)" preserveAspectRatio="xMidYMid slice"/>` : ""}
  <text x="58" y="28" class="tick">${esc(user.login.toUpperCase())}</text>
  <text x="58" y="42" class="sub">GITHUB · PUBLIC ACTIVITY</text>
  <rect x="310" y="19" width="62" height="18" rx="4" fill="#0d2a12" stroke="#1d4a24"/>
  <circle class="ping" cx="322" cy="28" r="3" fill="#00c805"/>
  <circle class="pulse" cx="322" cy="28" r="3" fill="#00c805"/>
  <text x="332" y="32" class="live">LIVE</text>
  <text x="${FULL - 20}" y="32" class="sub" text-anchor="end">${stamp}</text>
  <line x1="0" y1="58" x2="${FULL}" y2="58" stroke="#1a1c1f"/>`,
  body: `  <text x="20" y="110" class="big">${total}</text>
  <text x="20" y="128" class="lab">CONTRIBUTIONS · TRAILING 12M</text>
  <text x="20" y="150" class="chg mono">${up ? "▲" : "▼"} ${up ? "+" : ""}${delta} <tspan class="lab">7D VS PRIOR 7D</tspan></text>
  <line x1="440" y1="58" x2="440" y2="162" stroke="#141619"/>
  ${[0.33, 0.66].map((f) => `<line x1="470" y1="${(64 + 84 * f).toFixed(1)}" x2="850" y2="${(64 + 84 * f).toFixed(1)}" stroke="#141619"/>`).join("\n  ")}
  <g clip-path="url(#plot)">
    ${series.map((v, i) => {
      const h = v ? Math.max(2, (v / hi) * 80) : 1.5;
      return `<rect x="${(470 + i * bw1).toFixed(1)}" y="${(148 - h).toFixed(1)}" width="${(bw1 - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${v ? "url(#bar)" : "#1e2126"}"/>`;
    }).join("\n    ")}
    <rect class="scan" x="470" y="64" width="2" height="84" fill="url(#cursor)"/>
  </g>
  <line x1="470" y1="148" x2="850" y2="148" stroke="#2a2d32"/>
  <text x="470" y="161" class="lab">52W · WEEKLY</text>
  <text x="850" y="161" class="lab" text-anchor="end">PEAK ${hi}</text>
  <line x1="0" y1="172" x2="${FULL}" y2="172" stroke="#1a1c1f"/>
  ${FIG.map(([label, value], i) => `<g>
    <text x="${20 + i * 142}" y="190" class="key">${label}</text>
    <text x="${20 + i * 142}" y="205" class="val">${value}</text>
  </g>`).join("\n  ")}`,
});

/* ── 2. La série cumulée ─────────────────────────────────────────────────────────────────────────────── */

const ax = 20, ay = 58, aw = HALF - 40, ah = 92;
const aPts = cumulative.map((v, i) => [ax + (i / (cumulative.length - 1 || 1)) * aw, ay + ah - (v / Math.max(1, total)) * ah]);
const aLine = aPts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
const aEnd = aPts[aPts.length - 1];

const activity = widget({
  w: HALF, h: 190, title: "CUMULATIVE CONTRIBUTIONS", note: "12M",
  label: `Contributions cumulées sur douze mois : ${total} au total.`,
  desc: `La même série, cumulée semaine après semaine, de 0 à ${total}. ${SOURCE}`,
  css: `
      .trace { animation: trace 9s ease-in-out infinite; }
      @keyframes trace { 0%, 100% { transform: translateX(0); opacity: 0; } 8% { opacity: 1; } 50% { transform: translateX(${aw}px); opacity: .8; } 92% { opacity: 0; } }`,
  body: `  ${[0.33, 0.66].map((f) => `<line x1="${ax}" y1="${(ay + ah * f).toFixed(1)}" x2="${ax + aw}" y2="${(ay + ah * f).toFixed(1)}" stroke="#141619"/>`).join("\n  ")}
  <path d="${aLine} L${(ax + aw).toFixed(1)} ${ay + ah} L${ax} ${ay + ah} Z" fill="url(#area)"/>
  <path d="${aLine}" fill="none" stroke="#00c805" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  <rect class="trace" x="${ax}" y="${ay}" width="2" height="${ah}" fill="url(#cursor)"/>
  <circle class="ping" cx="${aEnd[0].toFixed(1)}" cy="${aEnd[1].toFixed(1)}" r="3" fill="#00c805"/>
  <circle cx="${aEnd[0].toFixed(1)}" cy="${aEnd[1].toFixed(1)}" r="2.6" fill="#00c805"/>
  <line x1="${ax}" y1="${ay + ah}" x2="${ax + aw}" y2="${ay + ah}" stroke="#2a2d32"/>
  <text x="${ax}" y="${ay + ah + 15}" class="lab">0</text>
  <text x="${ax + aw}" y="${ay + ah + 15}" class="lab" text-anchor="end">${total}</text>
  <text x="${ax}" y="${ay + ah + 32}" class="foot">${active} ACTIVE DAYS · PEAK ${hi}/W</text>`,
});

/* ── 3. La répartition de l'activité ─────────────────────────────────────────────────────────────────── */

const dcx = 92, dcy = 116, dr = 42, dsw = 15, circ = 2 * Math.PI * dr;
let off = 0;
const rings = MIX.map(([, v], i) => {
  const len = (v / mixTotal) * circ;
  const seg = `<circle cx="${dcx}" cy="${dcy}" r="${dr}" fill="none" stroke="${RAMP[i]}" stroke-width="${dsw}"
      stroke-dasharray="${(len - 1.5).toFixed(2)} ${(circ - len + 1.5).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 ${dcx} ${dcy})"/>`;
  off += len;
  return seg;
}).join("\n  ");

const mix = widget({
  w: HALF, h: 190, title: "ACTIVITY MIX", note: "12M",
  label: `Répartition de l'activité : ${MIX.map(([l, v]) => `${v} ${l.toLowerCase()}`).join(", ")}.`,
  desc: `Les natures que l'API compte séparément : ${MIX.map(([l, v]) => `${l.toLowerCase()} ${v} (${pct(v, mixTotal)})`).join(", ")}. ${SOURCE}`,
  css: `
      .spin { animation: spin 18s linear infinite; transform-origin: ${dcx}px ${dcy}px; }
      @keyframes spin { to { transform: rotate(360deg); } }`,
  body: `  <circle cx="${dcx}" cy="${dcy}" r="${dr}" fill="none" stroke="#17191d" stroke-width="${dsw}"/>
  ${rings}
  <circle class="spin" cx="${dcx}" cy="${dcy}" r="${dr + 12}" fill="none" stroke="#00c805" stroke-opacity=".5" stroke-width="1" stroke-dasharray="2 10"/>
  <text x="${dcx}" y="${dcy + 3}" class="val" text-anchor="middle">${mixTotal}</text>
  <text x="${dcx}" y="${dcy + 17}" class="tiny" text-anchor="middle">EVENTS</text>
  ${MIX.map(([label, v], i) => `<g>
    <rect x="166" y="${78 + i * 24}" width="9" height="9" rx="2" fill="${RAMP[i]}"/>
    <text x="182" y="${86 + i * 24}" class="leg">${label}</text>
    <text x="${HALF - 20}" y="${86 + i * 24}" class="num" text-anchor="end">${v} · ${pct(v, mixTotal)}</text>
  </g>`).join("\n  ")}`,
});

/* ── 4. La matrice d'activité ────────────────────────────────────────────────────────────────────────── */

const mx = 44, mTop = 72, mw = FULL - 20 - mx, cell = mw / 52, side = cell - 2.4;
const dayHi = Math.max(1, ...days.map((d) => d.contributionCount));
const lvl = (v) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / dayHi) * 4)));
const grid = weeksRaw
  .map((w, i) => w.contributionDays.map((d) => {
    const l = lvl(d.contributionCount), row = (d.weekday + 6) % 7;
    return `<rect${l ? ` class="cellule" style="animation-delay:${((i * 7 + row) % 19) * 0.33}s"` : ""} x="${(mx + i * cell).toFixed(1)}" y="${(mTop + row * (side + 2.4)).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="2" fill="${HEAT[l]}"/>`;
  }).join("")).join("\n  ");

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
let lastM = -1;
const ticks = weeksRaw.map((w, i) => {
  const m = new Date(w.contributionDays[0].date).getUTCMonth();
  if (m === lastM || i > 49) return "";
  lastM = m;
  return `<text x="${(mx + i * cell).toFixed(1)}" y="${mTop - 8}" class="tiny">${MONTHS[m]}</text>`;
}).join("");
const mBottom = mTop + 7 * (side + 2.4);

const matrix = widget({
  w: FULL, h: Math.round(mBottom + 36), title: "ACTIVITY MATRIX", note: `52W × 7D · PEAK ${dayHi}/D`,
  label: `Matrice d'activité : ${active} jours actifs sur 365, jusqu'à ${dayHi} contributions en un jour.`,
  desc: `Une case par jour sur cinquante-deux semaines ; ${active} jours actifs, pic de ${dayHi} en un jour. ${SOURCE}`,
  body: `  ${ticks}
  ${["MON", "", "WED", "", "FRI", "", "SUN"].map((d, i) => d ? `<text x="20" y="${(mTop + i * (side + 2.4) + side - 2).toFixed(1)}" class="tiny">${d}</text>` : "").join("")}
  ${grid}
  <text x="20" y="${(mBottom + 18).toFixed(1)}" class="foot">${active} ACTIVE DAYS · ${((active / 365) * 100).toFixed(0)}% OF YEAR</text>
  <g transform="translate(${FULL - 148} ${(mBottom + 8).toFixed(1)})">
    <text x="0" y="8" class="tiny">LESS</text>
    ${HEAT.map((f, i) => `<rect x="${30 + i * 12}" y="1" width="10" height="10" rx="2" fill="${f}"/>`).join("")}
    <text x="128" y="8" class="tiny" text-anchor="end">MORE</text>
  </g>`,
});

/* ── 5. L'allocation par langage ─────────────────────────────────────────────────────────────────────── */

let lx = 20;
const alloc = LANGS.map(([, v], i) => {
  const w = (v / langTotal) * (HALF - 40);
  const seg = `<rect x="${lx.toFixed(1)}" y="60" width="${Math.max(0, w - 1).toFixed(1)}" height="18" fill="${RAMP[i]}"/>`;
  lx += w;
  return seg;
}).join("\n    ");

const languages = widget({
  w: HALF, h: 212, title: "LANGUAGE ALLOCATION", note: "BY BYTES",
  label: `Répartition par langage : ${LANGS.map(([l, v]) => `${l} ${pct(v, langTotal)}`).join(", ")}.`,
  desc: `Les octets de code des dépôts publics, par langage : ${LANGS.map(([l, v]) => `${l} ${pct(v, langTotal)}`).join(", ")}. ${SOURCE}`,
  css: `
      .gloss { animation: gloss 10s cubic-bezier(.45,0,.2,1) infinite; }
      @keyframes gloss { 0% { transform: translateX(-120px); opacity: 0; } 12% { opacity: 1; } 65%, 100% { transform: translateX(${HALF - 40}px); opacity: 0; } }`,
  defs: `<clipPath id="alloc"><rect x="20" y="60" width="${HALF - 40}" height="18" rx="4"/></clipPath>`,
  body: `  <g clip-path="url(#alloc)">
    ${alloc}
    <rect class="gloss" x="20" y="60" width="110" height="18" fill="url(#gloss)"/>
  </g>
  ${LANGS.map(([label, v], i) => `<g>
    <rect x="${20 + (i % 2) * 196}" y="${96 + Math.floor(i / 2) * 22}" width="9" height="9" rx="2" fill="${RAMP[i]}"/>
    <text x="${36 + (i % 2) * 196}" y="${104 + Math.floor(i / 2) * 22}" class="leg">${esc(label.toUpperCase())}</text>
    <text x="${176 + (i % 2) * 196}" y="${104 + Math.floor(i / 2) * 22}" class="num" text-anchor="end">${pct(v, langTotal)}</text>
  </g>`).join("\n  ")}
  <text x="20" y="202" class="foot">${byLang.size} LANGUAGES · ${bulk} ACROSS ${user.repositories.totalCount} PUBLIC REPOS</text>`,
});

/* ── 6. Le profil hebdomadaire ───────────────────────────────────────────────────────────────────────── */

const wbw = (HALF - 40) / 7;
const weekdayCard = widget({
  w: HALF, h: 190, title: "WEEKDAY PROFILE", note: "12M",
  label: `Profil hebdomadaire : ${WD.map((d, i) => `${d} ${weekday[i]}`).join(", ")}.`,
  desc: `Ce que pèse chaque jour de la semaine sur douze mois : ${WD.map((d, i) => `${d.toLowerCase()} ${weekday[i]}`).join(", ")}. ${SOURCE}`,
  body: `  <line x1="20" y1="148" x2="${HALF - 20}" y2="148" stroke="#2a2d32"/>
  ${weekday.map((v, i) => {
    const h = v ? Math.max(3, (v / wdHi) * 74) : 2;
    return `<g>
    <rect class="grow" x="${(20 + i * wbw + 7).toFixed(1)}" y="${(148 - h).toFixed(1)}" width="${(wbw - 14).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${v === wdHi ? "#00c805" : "#17622b"}" style="animation-delay:${i * 0.3}s"/>
    <text x="${(20 + i * wbw + wbw / 2).toFixed(1)}" y="162" class="tiny" text-anchor="middle">${WD[i]}</text>
    <text x="${(20 + i * wbw + wbw / 2).toFixed(1)}" y="${(142 - h).toFixed(1)}" class="tiny" text-anchor="middle">${v}</text>
  </g>`;
  }).join("\n  ")}
  <text x="20" y="180" class="foot">BUSIEST ${WD[weekday.indexOf(wdHi)]} · ${wdHi} CONTRIBUTIONS</text>`,
});

/* ── 7. Les millésimes ───────────────────────────────────────────────────────────────────────────────── */

const vbw = (HALF - 40) / Math.max(1, vintage.length);
const vintageCard = widget({
  w: HALF, h: 190, title: "REPOSITORIES BY VINTAGE", note: "PUBLIC · COUNT",
  label: `Dépôts publics ouverts par année : ${vintage.map(([y, n]) => `${y} ${n}`).join(", ")}.`,
  desc: `Combien de dépôts publics ouverts chaque année : ${vintage.map(([y, n]) => `${y} : ${n}`).join(", ")}. Des comptes, pas des noms. ${SOURCE}`,
  body: `  <line x1="20" y1="148" x2="${HALF - 20}" y2="148" stroke="#2a2d32"/>
  ${vintage.map(([y, n], i) => {
    const h = Math.max(3, (n / vintageHi) * 74);
    return `<g>
    <rect class="grow" x="${(20 + i * vbw + 10).toFixed(1)}" y="${(148 - h).toFixed(1)}" width="${(vbw - 20).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${RAMP[Math.min(i, 5)]}" style="animation-delay:${i * 0.35}s"/>
    <text x="${(20 + i * vbw + vbw / 2).toFixed(1)}" y="162" class="tiny" text-anchor="middle">${y}</text>
    <text x="${(20 + i * vbw + vbw / 2).toFixed(1)}" y="${(142 - h).toFixed(1)}" class="tiny" text-anchor="middle">${n}</text>
  </g>`;
  }).join("\n  ")}
  <text x="20" y="180" class="foot">SINCE ${since} · ${user.repositories.totalCount} PUBLIC REPOS · ${stars} STARS</text>`,
});

/* ── 8. La distribution des tailles ──────────────────────────────────────────────────────────────────── */

const sizeCard = widget({
  w: HALF, h: 190, title: "SIZE DISTRIBUTION", note: `TOP ${sizes.length} · ${UNIT} · UNNAMED`,
  label: `Tailles des plus gros dépôts publics, par rang : ${sizes.map((v, i) => `#${i + 1} ${v.toFixed(1)} ${UNIT}`).join(", ")}.`,
  desc: `La distribution des plus gros dépôts publics, par rang, en ${UNIT === "MB" ? "mégaoctets" : "kilo-octets"} : ${sizes.map((v, i) => `#${i + 1} ${v.toFixed(1)}`).join(", ")}. Aucun n'est nommé. ${SOURCE}`,
  body: `  ${sizes.map((mb, i) => {
    const y = 58 + i * 18;
    return `<g>
    <text x="20" y="${y + 8}" class="tiny">#${i + 1}</text>
    <rect x="44" y="${y}" width="${HALF - 110}" height="9" rx="2" fill="#17191d"/>
    <rect class="grow" x="44" y="${y}" width="${Math.max(2, (mb / sizeHi) * (HALF - 110)).toFixed(1)}" height="9" rx="2" fill="${RAMP[Math.min(i, 5)]}" style="animation-delay:${i * 0.25}s"/>
    <text x="${HALF - 20}" y="${y + 8}" class="num" text-anchor="end">${mb.toFixed(1)}</text>
  </g>`;
  }).join("\n  ")}
  <text x="20" y="180" class="foot">${bulk} TOTAL · AGGREGATED, NO NAMES</text>`,
});

/* ── 9. Le radar : les sept jours sur sept axes ──────────────────────────────────────────────────────── */

const rcx = 214, rcy = 122, rR = 58;
const axis = (i) => (-Math.PI / 2) + (i * 2 * Math.PI) / 7;
const at = (i, f) => [rcx + Math.cos(axis(i)) * rR * f, rcy + Math.sin(axis(i)) * rR * f];
const poly = (f) => WD.map((_, i) => at(i, f).map((n) => n.toFixed(1)).join(",")).join(" ");
const shape = weekday.map((v, i) => at(i, Math.max(0.03, v / wdHi)).map((n) => n.toFixed(1)).join(",")).join(" ");

const radar = widget({
  w: HALF, h: 212, title: "WEEKDAY RADAR", note: "12M · CONTRIBUTIONS",
  label: `Radar des jours de la semaine : ${WD.map((d, i) => `${d} ${weekday[i]}`).join(", ")}.`,
  desc: `Les sept jours de la semaine sur sept axes, en contributions sur douze mois : ${WD.map((d, i) => `${d.toLowerCase()} ${weekday[i]}`).join(", ")}. L'axe va de 0 à ${wdHi}. ${SOURCE}`,
  css: `
      .sweep { animation: sweep 7s linear infinite; transform-origin: ${rcx}px ${rcy}px; }
      @keyframes sweep { to { transform: rotate(360deg); } }
      .vtx { animation: cellule 4s ease-in-out infinite alternate; }`,
  defs: `<radialGradient id="beam" cx="0" cy="0" r="1">
      <stop offset="0" stop-color="#00c805" stop-opacity=".35"/><stop offset="1" stop-color="#00c805" stop-opacity="0"/>
    </radialGradient>`,
  body: `  ${[0.25, 0.5, 0.75, 1].map((f) => `<polygon points="${poly(f)}" fill="none" stroke="#1a1d21"/>`).join("\n  ")}
  ${WD.map((_, i) => `<line x1="${rcx}" y1="${rcy}" x2="${at(i, 1)[0].toFixed(1)}" y2="${at(i, 1)[1].toFixed(1)}" stroke="#1a1d21"/>`).join("\n  ")}
  <g class="sweep"><path d="M${rcx} ${rcy} L${rcx} ${rcy - rR} A${rR} ${rR} 0 0 1 ${(rcx + rR * Math.cos(-Math.PI / 2 + 1.1)).toFixed(1)} ${(rcy + rR * Math.sin(-Math.PI / 2 + 1.1)).toFixed(1)} Z" fill="url(#beam)"/>
    <line x1="${rcx}" y1="${rcy}" x2="${rcx}" y2="${rcy - rR}" stroke="#4dec6a" stroke-width="1" opacity=".7"/></g>
  <polygon points="${shape}" fill="#00c805" fill-opacity=".22" stroke="#00c805" stroke-width="1.8" stroke-linejoin="round"/>
  ${weekday.map((v, i) => {
    const [x, y] = at(i, Math.max(0.03, v / wdHi));
    return `<circle class="vtx" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${v === wdHi ? "#4dec6a" : "#00c805"}" style="animation-delay:${i * 0.25}s"/>`;
  }).join("\n  ")}
  ${WD.map((d, i) => {
    const [x, y] = at(i, 1.24);
    const anchorX = Math.cos(axis(i));
    const align = anchorX > 0.3 ? "start" : anchorX < -0.3 ? "end" : "middle";
    return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" class="tiny" text-anchor="${align}">${d} ${weekday[i]}</text>`;
  }).join("\n  ")}
  <text x="20" y="202" class="foot">AXIS 0 → ${wdHi} · BUSIEST ${WD[weekday.indexOf(wdHi)]}</text>`,
});

/* ── 10. Les séries de jours consécutifs ─────────────────────────────────────────────────────────────── */

const strip = days.slice(-30);
const stripHi = Math.max(1, ...strip.map((d) => d.contributionCount));
const streak = widget({
  w: HALF, h: 212, title: "STREAK", note: "12M · DAYS",
  label: `Séries de jours consécutifs : ${streaks.cur} en cours, ${streaks.best} au plus long, ${active} jours actifs.`,
  desc: `Jours consécutifs avec au moins une contribution : ${streaks.cur} en cours, record de ${streaks.best}${streaks.bestEnd ? ` clos le ${streaks.bestEnd}` : ""}, ${active} jours actifs sur 365. ${SOURCE}`,
  body: `  ${[["CURRENT", streaks.cur], ["LONGEST", streaks.best], ["ACTIVE", active]].map(([label, v], i) => `<g>
    <text x="${20 + i * 136}" y="76" class="big" style="font-size:34px">${v}</text>
    <text x="${20 + i * 136}" y="94" class="key">${label}</text>
  </g>`).join("\n  ")}
  <line x1="20" y1="112" x2="${HALF - 20}" y2="112" stroke="#1a1c1f"/>
  <text x="20" y="130" class="lab">LAST 30 DAYS</text>
  <line x1="20" y1="168" x2="${HALF - 20}" y2="168" stroke="#2a2d32"/>
  ${strip.map((d, i) => {
    const bw = (HALF - 40) / 30, h = d.contributionCount ? Math.max(3, (d.contributionCount / stripHi) * 30) : 2;
    return `<rect class="grow" x="${(20 + i * bw + 1).toFixed(1)}" y="${(168 - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${d.contributionCount ? "#00c805" : "#1e2126"}" style="animation-delay:${(i % 10) * 0.3}s"/>`;
  }).join("\n  ")}
  <text x="20" y="202" class="foot">${streaks.curEnd ? `LAST CONTRIBUTION ${streaks.curEnd}` : "NO CONTRIBUTION IN WINDOW"}</text>`,
});

/* ── 11. Le cadran des heures ────────────────────────────────────────────────────────────────────────── */

const kcx = 214, kcy = 110, kIn = 22, kOut = 52;
const clockCard = widget({
  w: HALF, h: 212, title: "PRODUCTIVE HOURS", note: "PARIS TIME",
  label: `Heures d'activité : ${clock.map((v, h) => (v ? `${h}h ${v}` : "")).filter(Boolean).join(", ") || "aucun événement public"}.`,
  desc: `Les heures où tombent les ${events.length} derniers événements publics (${window}), heure de Paris. Le pic est de ${clockHi} à ${clock.indexOf(clockHi)} h. ${SOURCE}`,
  css: `
      .hand { animation: hand 24s linear infinite; transform-origin: ${kcx}px ${kcy}px; }
      @keyframes hand { to { transform: rotate(360deg); } }`,
  body: `  <circle cx="${kcx}" cy="${kcy}" r="${kOut}" fill="none" stroke="#1a1d21"/>
  <circle cx="${kcx}" cy="${kcy}" r="${kIn}" fill="none" stroke="#1a1d21"/>
  ${clock.map((v, h) => {
    const a = (-Math.PI / 2) + (h * 2 * Math.PI) / 24;
    const len = kIn + (v / clockHi) * (kOut - kIn);
    const x1 = kcx + Math.cos(a) * kIn, y1 = kcy + Math.sin(a) * kIn;
    const x2 = kcx + Math.cos(a) * Math.max(kIn + 1.5, len), y2 = kcy + Math.sin(a) * Math.max(kIn + 1.5, len);
    return `<line class="${v ? "grow" : ""}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${v === clockHi && v ? "#4dec6a" : v ? "#00c805" : "#1e2126"}" stroke-width="5" stroke-linecap="round" style="animation-delay:${(h % 8) * 0.3}s"/>`;
  }).join("\n  ")}
  <line class="hand" x1="${kcx}" y1="${kcy}" x2="${kcx}" y2="${kcy - kOut - 4}" stroke="#4dec6a" stroke-width="1" opacity=".55"/>
  ${[0, 6, 12, 18].map((h) => {
    const a = (-Math.PI / 2) + (h * 2 * Math.PI) / 24;
    return `<text x="${(kcx + Math.cos(a) * (kOut + 12)).toFixed(1)}" y="${(kcy + Math.sin(a) * (kOut + 12) + 3).toFixed(1)}" class="tiny" text-anchor="middle">${String(h).padStart(2, "0")}</text>`;
  }).join("\n  ")}
  <text x="${kcx}" y="${kcy + 3}" class="num" text-anchor="middle">${clockHi ? `${String(clock.indexOf(clockHi)).padStart(2, "0")}H` : "—"}</text>
  <text x="20" y="202" class="foot">${events.length} PUBLIC EVENTS · ${window}</text>`,
});

/* ── 12. La carte perforée : jour de la semaine × heure ──────────────────────────────────────────────── */

const px0 = 58, pxStep = (FULL - 20 - px0) / 23, py0 = 72, pyStep = 20;
const punchCard = widget({
  w: FULL, h: 212, title: "PUNCH CARD", note: `WEEKDAY × HOUR · PARIS TIME · PEAK ${punchHi}`,
  label: `Carte perforée : quand tombent les ${events.length} derniers événements publics, par jour de la semaine et par heure.`,
  desc: `Chaque disque dit combien d'événements publics sont tombés ce jour-là à cette heure-là, sur les ${events.length} derniers (${window}), heure de Paris. Le plus gros en vaut ${punchHi}. ${SOURCE}`,
  body: `  ${[0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<text x="${(px0 + h * pxStep).toFixed(1)}" y="${py0 - 12}" class="tiny" text-anchor="middle">${String(h).padStart(2, "0")}</text>`).join("\n  ")}
  ${WD.map((d, r) => `<text x="20" y="${(py0 + r * pyStep + 3).toFixed(1)}" class="tiny">${d}</text>`).join("\n  ")}
  ${punch.map((row, r) => row.map((v, h) => {
    const cx = px0 + h * pxStep, cy = py0 + r * pyStep;
    if (!v) return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="1.4" fill="#1e2126"/>`;
    const rad = 2.5 + (v / punchHi) * 6;
    return `<circle class="cellule" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="${v === punchHi ? "#4dec6a" : "#00c805"}" fill-opacity=".9" style="animation-delay:${((r * 24 + h) % 17) * 0.3}s"/>`;
  }).join("")).join("\n  ")}
  <text x="20" y="${py0 + 7 * pyStep + 12}" class="foot">${events.length} PUBLIC EVENTS · ${window} · AREA ∝ COUNT</text>`,
});

/* ── 13. L'année en relief ───────────────────────────────────────────────────────────────────────────── */

// Projection cisaillée : les semaines avancent à l'horizontale, les jours en biais. Une vraie isométrie
// tracerait une diagonale perdue dans le vide — là, le relief occupe tout le cadre.
const TW = 14.4, TH = 11, SKEW = 7, TOWER = 34;
const SHADE = [
  ["#15171a", "#101215", "#0b0d10"],
  ["#0b4a22", "#083a1b", "#062c14"],
  ["#0a7a31", "#086026", "#06491d"],
  ["#00a83d", "#008731", "#006526"],
  ["#4dec6a", "#35c352", "#27953e"],
];
const isoOx = 52, isoOy = 104;
const face = (pts, fill, cls = "") => `<path${cls} d="M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L")} Z" fill="${fill}"/>`;
const relief = [];
for (let row = 0; row < 7; row++) {
  for (let col = 0; col < weeksRaw.length; col++) {
    const day = weeksRaw[col].contributionDays.find((d) => (d.weekday + 6) % 7 === row);
    if (!day) continue;
    const v = day.contributionCount;
    const h = v ? 3 + (v / dayHi) * TOWER : 0;
    const bx = isoOx + col * TW + row * SKEW, by = isoOy + row * TH;
    const top = [[bx, by - h], [bx + TW - 1.4, by - h], [bx + TW - 1.4 + SKEW, by + TH - 1.4 - h], [bx + SKEW, by + TH - 1.4 - h]];
    const [tc, rc, fc] = SHADE[lvl(v)];
    if (h > 0) {
      relief.push(face([top[3], top[2], [top[2][0], top[2][1] + h], [top[3][0], top[3][1] + h]], fc));
      relief.push(face([top[1], top[2], [top[2][0], top[2][1] + h], [top[1][0], top[1][1] + h]], rc));
    }
    relief.push(face(top, tc, h > 0 ? ` class="cellule" style="animation-delay:${((col * 7 + row) % 19) * 0.33}s"` : ""));
  }
}
const isoH = Math.round(isoOy + 7 * TH + 40);

const iso = widget({
  w: FULL, h: isoH, title: "YEAR IN RELIEF", note: `52W × 7D · HEIGHT ∝ CONTRIBUTIONS · PEAK ${dayHi}/D`,
  label: `L'année en relief : chaque jour est une tuile, sa hauteur vaut ses contributions, jusqu'à ${dayHi} en un jour.`,
  desc: `La même année qu'en matrice, vue en relief : une tuile par jour, la hauteur valant les contributions du jour, pic de ${dayHi}. ${active} jours actifs. ${SOURCE}`,
  body: `  ${["MON", "", "WED", "", "FRI", "", "SUN"].map((d, i) => d ? `<text x="20" y="${(isoOy + i * TH + 8).toFixed(1)}" class="tiny">${d}</text>` : "").join("")}
  ${relief.join("\n  ")}
  <text x="20" y="${isoH - 16}" class="foot">${active} ACTIVE DAYS · ${total} CONTRIBUTIONS · 52 WEEKS TO ${days[days.length - 1].date}</text>`,
});

/* ── Écriture ────────────────────────────────────────────────────────────────────────────────────────── */

mkdirSync("assets", { recursive: true });
rmSync("assets/card.svg", { force: true });
rmSync("assets/telemetry.svg", { force: true });
rmSync("assets/weekday.svg", { force: true });
const files = {
  "summary.svg": summary,
  "activity.svg": activity,
  "mix.svg": mix,
  "matrix.svg": matrix,
  "iso.svg": iso,
  "languages.svg": languages,
  "radar.svg": radar,
  "streak.svg": streak,
  "clock.svg": clockCard,
  "punch.svg": punchCard,
  "vintage.svg": vintageCard,
  "size.svg": sizeCard,
};
for (const [name, body] of Object.entries(files)) writeFileSync(`assets/${name}`, body);

console.log(
  `${user.login} — ${total} contributions 12M (7D ${up ? "+" : ""}${delta})\n` +
    `public: ${user.repositories.totalCount} repos · ${mergedPr} merged PR · ${byLang.size} langages · ${stars}★ · ${bulk}\n` +
    `mix ${MIX.map(([l, v]) => `${l.toLowerCase()} ${v}`).join(", ")}\n` +
    `langs ${LANGS.map(([l, v]) => `${l} ${pct(v, langTotal)}`).join(", ")}\n` +
    `streak ${streaks.cur} en cours, record ${streaks.best} · ${events.length} événements publics (${window})\n` +
    Object.entries(files).map(([n, b]) => `${n} ${(b.length / 1024).toFixed(1)} Ko`).join(" · "),
);
