#!/usr/bin/env node
/**
 * Fiche de cotation du compte GitHub, dessinée à partir des seuls chiffres que l'API rend.
 *
 * Rien n'est noté, pondéré ni arrondi : chaque panneau dit la mesure qu'il trace et d'où elle vient. Les dépôts
 * ne sont lus qu'en **agrégat** — langages, millésimes, tailles, étoiles : jamais un nom, jamais un contenu,
 * jamais une description. Le portrait est embarqué en base64 (une image liée par URL n'est pas chargée quand
 * GitHub sert le SVG comme une image).
 *
 *   node scripts/card.mjs            # écrit assets/card.svg
 *   GITHUB_TOKEN=… node scripts/card.mjs
 *
 * Le jeton n'a besoin que de la lecture publique. Avec un jeton personnel et le réglage « include private
 * contributions » du profil, les contributions privées entrent dans les séries.
 */

import { writeFileSync, mkdirSync } from "node:fs";

const LOGIN = process.env.CARD_LOGIN ?? "Baptoshi";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("card: il faut un jeton GitHub dans GITHUB_TOKEN (lecture publique suffit).");
  process.exit(2);
}

const QUERY = `query($login: String!) {
  user(login: $login) {
    name login avatarUrl createdAt
    followers { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { contributionCount date weekday } }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
      totalCount
      nodes {
        stargazerCount forkCount createdAt diskUsage isArchived
        languages(first: 8, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
      }
    }
    pullRequests(states: MERGED) { totalCount }
  }
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

const { user } = await api(QUERY, { login: LOGIN });
const c = user.contributionsCollection;
const repos = user.repositories.nodes;
const weeksRaw = c.contributionCalendar.weeks.slice(-52);
const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);

/* ── Ce que la fiche trace, tiré des réponses de l'API et de rien d'autre ────────────────────────────── */

const active = days.filter((d) => d.contributionCount > 0).length;
const stars = repos.reduce((t, r) => t + r.stargazerCount, 0);
const forks = repos.reduce((t, r) => t + r.forkCount, 0);
const disk = repos.reduce((t, r) => t + (r.diskUsage ?? 0), 0); // en Ko, tel que l'API le donne

// Série hebdomadaire, et la même cumulée : deux lectures d'une seule donnée.
const series = weeksRaw.map((w) => w.contributionDays.reduce((t, d) => t + d.contributionCount, 0));
const hi = Math.max(1, ...series);
let run = 0;
const cumulative = series.map((v) => (run += v));
const total = c.contributionCalendar.totalContributions;

const last7 = days.slice(-7).reduce((t, d) => t + d.contributionCount, 0);
const prev7 = days.slice(-14, -7).reduce((t, d) => t + d.contributionCount, 0);
const delta = last7 - prev7;
const up = delta >= 0;

// Répartition de l'activité : les quatre natures que l'API compte séparément.
const MIX = [
  ["COMMITS", c.totalCommitContributions],
  ["PULL REQUESTS", c.totalPullRequestContributions],
  ["ISSUES", c.totalIssueContributions],
  ["REVIEWS", c.totalPullRequestReviewContributions],
].filter(([, v]) => v > 0);
const mixTotal = Math.max(1, MIX.reduce((t, [, v]) => t + v, 0));

// Langages pesés en octets, tous dépôts confondus. Un langage n'est pas un nom de dépôt : rien n'en sort.
const byLang = new Map();
for (const r of repos) for (const e of r.languages.edges) byLang.set(e.node.name, (byLang.get(e.node.name) ?? 0) + e.size);
const langTotal = Math.max(1, [...byLang.values()].reduce((t, v) => t + v, 0));
const langs = [...byLang.entries()].sort((a, b) => b[1] - a[1]);
const LANGS = langs.slice(0, 6);
const langRest = langs.slice(6).reduce((t, [, v]) => t + v, 0);
if (langRest > 0) LANGS.push(["OTHER", langRest]);

// Profil hebdomadaire : ce que pèse chaque jour de la semaine sur douze mois.
const WD = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const weekday = WD.map((_, i) => days.filter((d) => d.weekday === (i + 1) % 7).reduce((t, d) => t + d.contributionCount, 0));
const wdHi = Math.max(1, ...weekday);

// Millésimes : combien de dépôts ouverts chaque année. Des comptes, pas des noms.
const years = [...new Set(repos.map((r) => r.createdAt.slice(0, 4)))].sort();
const vintage = years.map((y) => [y, repos.filter((r) => r.createdAt.slice(0, 4) === y).length]);
const vintageHi = Math.max(1, ...vintage.map(([, n]) => n));

// Tailles : la distribution des plus gros dépôts, par rang. Anonymes par construction.
const sizes = repos.map((r) => (r.diskUsage ?? 0) / 1024).sort((a, b) => b - a).slice(0, 6);
const sizeHi = Math.max(0.1, ...sizes);

/** Portrait embarqué : une image liée par URL ne se charge pas dans un SVG servi comme image. */
const avatar = await fetch(`${user.avatarUrl}&s=200`).then(async (r) => {
  if (!r.ok) return null;
  const type = r.headers.get("content-type") ?? "image/png";
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (v, t) => `${((v / t) * 100).toFixed(1)}%`;
const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";
const since = user.createdAt.slice(0, 4);

/* ── Géométrie ───────────────────────────────────────────────────────────────────────────────────────── */

const W = 880, H = 1020;
const M = 40, COL = 390, GUT = 20, R = M + COL + GUT; // deux colonnes de 390, gouttière de 20

const RAMP = ["#00c805", "#06a830", "#0c8b3c", "#2a7248", "#45604f", "#5c6168", "#363b42"];
const HEAT = ["#17191d", "#0b4a22", "#0a7a31", "#00a83d", "#4dec6a"];

/** Un filet plein cadre, et la lumière qui le traverse de temps en temps. */
const rule = (y, delay = 0) => `<g>
    <line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#1a1c1f"/>
    <rect class="sheen" x="0" y="${y - 0.5}" width="200" height="1" fill="url(#sweep)" style="animation-delay:${delay}s"/>
  </g>`;

/** L'intitulé d'un panneau, et à droite ce que le panneau mesure. */
const head = (x, y, w, title, note) =>
  `<text x="${x}" y="${y}" class="sec">${title}</text>` +
  (note ? `<text x="${x + w}" y="${y}" class="lab" text-anchor="end">${note}</text>` : "");

/* ── Panneau : la série cumulée, douze mois ──────────────────────────────────────────────────────────── */

const cx0 = M, cy0 = 316, cw = COL, ch = 100;
const cPts = cumulative.map((v, i) => [cx0 + (i / (cumulative.length - 1 || 1)) * cw, cy0 + ch - (v / Math.max(1, total)) * ch]);
const cLine = cPts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
const cArea = `${cLine} L${(cx0 + cw).toFixed(1)} ${cy0 + ch} L${cx0} ${cy0 + ch} Z`;
const cEnd = cPts[cPts.length - 1];

/* ── Panneau : la répartition de l'activité, en anneau ───────────────────────────────────────────────── */

const dcx = R + 72, dcy = 370, dr = 46, dsw = 16;
const circ = 2 * Math.PI * dr;
let dOff = 0;
const donut = MIX.map(([label, v], i) => {
  const len = (v / mixTotal) * circ;
  const seg = `<circle cx="${dcx}" cy="${dcy}" r="${dr}" fill="none" stroke="${RAMP[i]}" stroke-width="${dsw}"
      stroke-dasharray="${(len - 1.5).toFixed(2)} ${(circ - len + 1.5).toFixed(2)}" stroke-dashoffset="${(-dOff).toFixed(2)}"
      transform="rotate(-90 ${dcx} ${dcy})"/>`;
  dOff += len;
  return seg;
}).join("\n    ");

/* ── Panneau : la matrice d'activité, 52 semaines sur 7 jours ────────────────────────────────────────── */

const mx = M + 22, mTop = 518, mw = W - M - mx, cell = mw / 52, side = cell - 2.4;
const dayHi = Math.max(1, ...days.map((d) => d.contributionCount));
const level = (v) => (v === 0 ? 0 : Math.min(4, Math.ceil((v / dayHi) * 4)));
const matrix = weeksRaw
  .map((w, i) =>
    w.contributionDays
      .map((d) => {
        const lv = level(d.contributionCount);
        const row = (d.weekday + 6) % 7; // lundi en haut
        return `<rect${lv ? ` class="cellule" style="animation-delay:${((i * 7 + row) % 19) * 0.33}s"` : ""} x="${(mx + i * cell).toFixed(1)}" y="${(mTop + row * (side + 2.4)).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="2" fill="${HEAT[lv]}"/>`;
      })
      .join(""),
  )
  .join("\n    ");

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
let lastMonth = -1;
const monthTicks = weeksRaw
  .map((w, i) => {
    const m = new Date(w.contributionDays[0].date).getUTCMonth();
    if (m === lastMonth || i > 49) return "";
    lastMonth = m;
    return `<text x="${(mx + i * cell).toFixed(1)}" y="${mTop - 8}" class="tiny">${MONTHS[m]}</text>`;
  })
  .join("");

/* ── Le document ─────────────────────────────────────────────────────────────────────────────────────── */

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="${esc(user.login)} — fiche GitHub : ${total} contributions sur douze mois, ${user.pullRequests.totalCount} pull requests fusionnées, ${user.repositories.totalCount} dépôts publics, ${byLang.size} langages.">
  <title>${esc(user.login)} — GitHub</title>
  <desc>Chiffres publics GitHub de ${esc(user.name ?? user.login)}, arrêtés au ${stamp} : ${total} contributions sur douze mois (${c.totalCommitContributions} commits, ${c.totalPullRequestContributions} pull requests, ${c.totalIssueContributions} tickets, ${c.totalPullRequestReviewContributions} revues), ${user.pullRequests.totalCount} pull requests fusionnées, ${user.repositories.totalCount} dépôts publics, ${stars} étoiles, ${forks} forks, ${(disk / 1024).toFixed(0)} Mo. Les dépôts ne sont lus qu'en agrégat : ni nom, ni contenu, ni description.</desc>
  <defs>
    <linearGradient id="bars" x1="0" y1="100" x2="0" y2="182" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#00c805"/><stop offset="1" stop-color="#00c805" stop-opacity=".45"/>
    </linearGradient>
    <linearGradient id="curve" x1="0" y1="${cy0}" x2="0" y2="${cy0 + ch}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#00c805" stop-opacity=".3"/><stop offset="1" stop-color="#00c805" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="cursor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8dffa0" stop-opacity="0"/><stop offset=".45" stop-color="#8dffa0" stop-opacity=".75"/>
      <stop offset="1" stop-color="#8dffa0" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#00c805" stop-opacity="0"/><stop offset=".5" stop-color="#8dffa0" stop-opacity=".5"/>
      <stop offset="1" stop-color="#00c805" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".3"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="plot"><rect x="500" y="94" width="340" height="88"/></clipPath>
    <clipPath id="alloc"><rect x="${M}" y="692" width="${COL}" height="18" rx="4"/></clipPath>
    <clipPath id="face"><rect x="40" y="32" width="26" height="26" rx="7"/></clipPath>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .mono, .big, .val, .num { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
      .tick { font-size: 13px; fill: #fff; font-weight: 600; letter-spacing: 1.4px; }
      .sub  { font-size: 10.5px; fill: #6d7279; letter-spacing: 1.2px; }
      .sec  { font-size: 10px; fill: #e8eaed; letter-spacing: 1.8px; font-weight: 600; }
      .lab  { font-size: 9.5px; fill: #6d7279; letter-spacing: 1.5px; }
      .tiny { font-size: 8.5px; fill: #5d6268; letter-spacing: 1.1px; }
      .big  { font-size: 52px; fill: #fff; font-weight: 500; letter-spacing: -1.5px; }
      .chg  { font-size: 13px; fill: ${up ? "#00c805" : "#ff5000"}; font-weight: 600; }
      .key  { font-size: 10px; fill: #8b9199; letter-spacing: 1.3px; }
      .val  { font-size: 17px; fill: #fff; font-weight: 500; }
      .num  { font-size: 11px; fill: #c9ced4; }
      .leg  { font-size: 10px; fill: #a7adb4; letter-spacing: .6px; }
      .foot { font-size: 9.5px; fill: #5d6268; letter-spacing: 1.2px; }
      .live { font-size: 9.5px; fill: #00c805; letter-spacing: 1.6px; font-weight: 600; }

      .pulse { animation: pulse 2.6s ease-in-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
      .ping  { animation: ping 2.6s ease-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
      @keyframes ping { 0% { opacity: .55; transform: scale(1); } 70%, 100% { opacity: 0; transform: scale(3.4); } }
      .sheen { animation: sheen 11s cubic-bezier(.45,0,.2,1) infinite; }
      @keyframes sheen { 0% { transform: translateX(-200px); opacity: 0; } 10% { opacity: 1; } 60%, 100% { transform: translateX(${W}px); opacity: 0; } }
      .scan  { animation: scan 9s ease-in-out infinite; }
      @keyframes scan { 0%, 100% { transform: translateX(0); opacity: 0; } 8% { opacity: 1; } 50% { transform: translateX(340px); opacity: .9; } 92% { opacity: 0; } }
      .trace { animation: trace 9s ease-in-out infinite; }
      @keyframes trace { 0%, 100% { transform: translateX(0); opacity: 0; } 8% { opacity: 1; } 50% { transform: translateX(${COL}px); opacity: .8; } 92% { opacity: 0; } }
      .spin  { animation: spin 18s linear infinite; transform-origin: ${dcx}px ${dcy}px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .cellule { animation: cellule 6s ease-in-out infinite alternate; }
      @keyframes cellule { from { opacity: .5; } to { opacity: 1; } }
      .gloss { animation: gloss 10s cubic-bezier(.45,0,.2,1) infinite; }
      @keyframes gloss { 0% { transform: translateX(-120px); opacity: 0; } 12% { opacity: 1; } 65%, 100% { transform: translateX(${COL}px); opacity: 0; } }
      .grow  { animation: grow 5.5s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 50% 100%; }
      @keyframes grow { from { opacity: .55; } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .pulse, .ping, .sheen, .scan, .trace, .spin, .cellule, .gloss, .grow { animation: none; }
        .ping, .sheen, .scan, .trace, .gloss { opacity: 0; }
      }
    </style>
  </defs>

  <rect width="${W}" height="${H}" rx="14" fill="#0a0a0b"/>
  <rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="13.5" fill="none" stroke="#1a1c1f"/>

  <!-- en-tête -->
  ${avatar ? `<image href="${avatar}" x="40" y="32" width="26" height="26" clip-path="url(#face)" preserveAspectRatio="xMidYMid slice"/>` : ""}
  <text x="78" y="42" class="tick">${esc(user.login.toUpperCase())}</text>
  <text x="78" y="56" class="sub">GITHUB · PUBLIC ACTIVITY</text>
  <rect x="330" y="33" width="62" height="18" rx="4" fill="#0d2a12" stroke="#1d4a24"/>
  <circle class="ping" cx="342" cy="42" r="3" fill="#00c805"/>
  <circle class="pulse" cx="342" cy="42" r="3" fill="#00c805"/>
  <text x="352" y="46" class="live">LIVE</text>
  <text x="${W - 40}" y="46" class="sub" text-anchor="end">${stamp}</text>

  ${rule(76)}

  <!-- la mesure principale, et la série hebdomadaire -->
  <text x="40" y="146" class="big">${total}</text>
  <text x="40" y="166" class="lab">CONTRIBUTIONS · TRAILING 12M</text>
  <text x="40" y="192" class="chg mono">${up ? "▲" : "▼"} ${up ? "+" : ""}${delta} <tspan class="lab">7D VS PRIOR 7D</tspan></text>
  <line x1="460" y1="76" x2="460" y2="216" stroke="#141619"/>
  ${[0.25, 0.5, 0.75].map((f) => `<line x1="500" y1="${(100 + 82 * f).toFixed(1)}" x2="840" y2="${(100 + 82 * f).toFixed(1)}" stroke="#141619"/>`).join("\n  ")}
  <g clip-path="url(#plot)">
    ${series.map((v, i) => {
      const bw = 340 / series.length;
      const h = v ? Math.max(2, (v / hi) * 82) : 1.5;
      return `<rect x="${(500 + i * bw).toFixed(1)}" y="${(182 - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${v ? "url(#bars)" : "#1e2126"}"/>`;
    }).join("\n    ")}
    <rect class="scan" x="500" y="94" width="2" height="88" fill="url(#cursor)"/>
  </g>
  <line x1="500" y1="182" x2="840" y2="182" stroke="#2a2d32"/>
  <text x="500" y="197" class="lab">52W · WEEKLY</text>
  <text x="840" y="197" class="lab" text-anchor="end">PEAK ${hi}</text>

  ${rule(216, 2)}

  <!-- chiffres clés -->
  ${[
    ["MERGED PR", user.pullRequests.totalCount],
    ["REPOS", user.repositories.totalCount],
    ["LANGUAGES", byLang.size],
    ["STARS", stars],
    ["FORKS", forks],
    ["FOLLOWERS", user.followers.totalCount],
  ].map(([label, value], i) => `<g>
    <text x="${40 + i * 134}" y="240" class="key">${label}</text>
    <text x="${40 + i * 134}" y="262" class="val">${value}</text>
  </g>`).join("\n  ")}

  ${rule(276)}

  <!-- cumulé douze mois · répartition de l'activité -->
  ${head(M, 300, COL, "CUMULATIVE CONTRIBUTIONS", "12M")}
  ${[0.25, 0.5, 0.75].map((f) => `<line x1="${cx0}" y1="${(cy0 + ch * f).toFixed(1)}" x2="${cx0 + cw}" y2="${(cy0 + ch * f).toFixed(1)}" stroke="#141619"/>`).join("\n  ")}
  <path d="${cArea}" fill="url(#curve)"/>
  <path d="${cLine}" fill="none" stroke="#00c805" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
  <rect class="trace" x="${cx0}" y="${cy0}" width="2" height="${ch}" fill="url(#cursor)"/>
  <circle class="ping" cx="${cEnd[0].toFixed(1)}" cy="${cEnd[1].toFixed(1)}" r="3" fill="#00c805"/>
  <circle cx="${cEnd[0].toFixed(1)}" cy="${cEnd[1].toFixed(1)}" r="2.6" fill="#00c805"/>
  <line x1="${cx0}" y1="${cy0 + ch}" x2="${cx0 + cw}" y2="${cy0 + ch}" stroke="#2a2d32"/>
  <text x="${cx0}" y="${cy0 + ch + 15}" class="lab">0</text>
  <text x="${cx0 + cw}" y="${cy0 + ch + 15}" class="lab" text-anchor="end">${total}</text>

  ${head(R, 300, COL, "ACTIVITY MIX", "12M")}
  <circle cx="${dcx}" cy="${dcy}" r="${dr}" fill="none" stroke="#17191d" stroke-width="${dsw}"/>
  ${donut}
  <circle class="spin" cx="${dcx}" cy="${dcy}" r="${dr + 13}" fill="none" stroke="#00c805" stroke-opacity=".5" stroke-width="1" stroke-dasharray="2 10"/>
  <text x="${dcx}" y="${dcy + 3}" class="val" text-anchor="middle">${mixTotal}</text>
  <text x="${dcx}" y="${dcy + 17}" class="tiny" text-anchor="middle">EVENTS</text>
  ${MIX.map(([label, v], i) => `<g>
    <rect x="${R + 150}" y="${331 + i * 24}" width="9" height="9" rx="2" fill="${RAMP[i]}"/>
    <text x="${R + 166}" y="${339 + i * 24}" class="leg">${label}</text>
    <text x="${R + COL}" y="${339 + i * 24}" class="num" text-anchor="end">${v}  ·  ${pct(v, mixTotal)}</text>
  </g>`).join("\n  ")}

  ${rule(470, 4)}

  <!-- matrice d'activité -->
  ${head(M, 494, W - 2 * M, "ACTIVITY MATRIX", `52W × 7D · PEAK ${dayHi}/D`)}
  ${monthTicks}
  ${["MON", "", "WED", "", "FRI", "", "SUN"].map((d, i) => d ? `<text x="${M}" y="${(mTop + i * (side + 2.4) + side - 2).toFixed(1)}" class="tiny">${d}</text>` : "").join("")}
  <g>
    ${matrix}
  </g>
  <text x="${M}" y="${(mTop + 7 * (side + 2.4) + 14).toFixed(1)}" class="lab">${active} ACTIVE DAYS · ${((active / 365) * 100).toFixed(0)}% OF YEAR</text>
  <g transform="translate(${W - M - 128} ${(mTop + 7 * (side + 2.4) + 6).toFixed(1)})">
    <text x="0" y="8" class="tiny">LESS</text>
    ${HEAT.map((f, i) => `<rect x="${30 + i * 12}" y="1" width="10" height="10" rx="2" fill="${f}"/>`).join("")}
    <text x="128" y="8" class="tiny" text-anchor="end">MORE</text>
  </g>

  ${rule(650)}

  <!-- allocation par langage · profil hebdomadaire -->
  ${head(M, 674, COL, "LANGUAGE ALLOCATION", "BY BYTES")}
  <g clip-path="url(#alloc)">
    ${(() => { let x = M; return LANGS.map(([, v], i) => {
      const w = (v / langTotal) * COL;
      const seg = `<rect x="${x.toFixed(1)}" y="692" width="${Math.max(0, w - 1).toFixed(1)}" height="18" fill="${RAMP[i]}"/>`;
      x += w;
      return seg;
    }).join("\n    "); })()}
    <rect class="gloss" x="${M}" y="692" width="110" height="18" fill="url(#gloss)"/>
  </g>
  ${LANGS.map(([label, v], i) => `<g>
    <rect x="${M + (i % 2) * 198}" y="${727 + Math.floor(i / 2) * 22}" width="9" height="9" rx="2" fill="${RAMP[i]}"/>
    <text x="${M + 16 + (i % 2) * 198}" y="${735 + Math.floor(i / 2) * 22}" class="leg">${esc(label.toUpperCase())}</text>
    <text x="${M + 178 + (i % 2) * 198}" y="${735 + Math.floor(i / 2) * 22}" class="num" text-anchor="end">${pct(v, langTotal)}</text>
  </g>`).join("\n  ")}

  ${head(R, 674, COL, "WEEKDAY PROFILE", "12M")}
  <line x1="${R}" y1="780" x2="${R + COL}" y2="780" stroke="#2a2d32"/>
  ${weekday.map((v, i) => {
    const bw = COL / 7, h = v ? Math.max(3, (v / wdHi) * 76) : 2;
    return `<g>
    <rect class="grow" x="${(R + i * bw + 8).toFixed(1)}" y="${(780 - h).toFixed(1)}" width="${(bw - 16).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${v === wdHi ? "#00c805" : "#17622b"}" style="animation-delay:${i * 0.3}s"/>
    <text x="${(R + i * bw + bw / 2).toFixed(1)}" y="794" class="tiny" text-anchor="middle">${WD[i]}</text>
    <text x="${(R + i * bw + bw / 2).toFixed(1)}" y="${(774 - h).toFixed(1)}" class="tiny" text-anchor="middle">${v}</text>
  </g>`;
  }).join("\n  ")}

  ${rule(820, 6)}

  <!-- millésimes · distribution des tailles -->
  ${head(M, 844, COL, "REPOSITORIES BY VINTAGE", "COUNT")}
  <line x1="${M}" y1="952" x2="${M + COL}" y2="952" stroke="#2a2d32"/>
  ${vintage.map(([y, n], i) => {
    const bw = COL / vintage.length, h = Math.max(3, (n / vintageHi) * 84);
    return `<g>
    <rect class="grow" x="${(M + i * bw + 10).toFixed(1)}" y="${(952 - h).toFixed(1)}" width="${(bw - 20).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${RAMP[Math.min(i, 5)]}" style="animation-delay:${i * 0.35}s"/>
    <text x="${(M + i * bw + bw / 2).toFixed(1)}" y="966" class="tiny" text-anchor="middle">${y}</text>
    <text x="${(M + i * bw + bw / 2).toFixed(1)}" y="${(946 - h).toFixed(1)}" class="tiny" text-anchor="middle">${n}</text>
  </g>`;
  }).join("\n  ")}

  ${head(R, 844, COL, "SIZE DISTRIBUTION", "TOP 6 · MB · UNNAMED")}
  ${sizes.map((mb, i) => {
    const y = 862 + i * 17;
    return `<g>
    <text x="${R}" y="${y + 8}" class="tiny">#${i + 1}</text>
    <rect x="${R + 24}" y="${y}" width="${COL - 90}" height="9" rx="2" fill="#17191d"/>
    <rect class="grow" x="${R + 24}" y="${y}" width="${Math.max(2, (mb / sizeHi) * (COL - 90)).toFixed(1)}" height="9" rx="2" fill="${RAMP[Math.min(i, 5)]}" style="animation-delay:${i * 0.25}s"/>
    <text x="${R + COL}" y="${y + 8}" class="num" text-anchor="end">${mb.toFixed(1)}</text>
  </g>`;
  }).join("\n  ")}

  ${rule(980)}
  <text x="40" y="1002" class="foot">SINCE ${since} · ${(disk / 1024).toFixed(0)} MB ACROSS ${user.repositories.totalCount} REPOS · AGGREGATED, NO REPOSITORY NAMES OR CONTENT</text>
  <text x="${W - 40}" y="1002" class="foot" text-anchor="end">SOURCE: GITHUB GRAPHQL API</text>
</svg>
`;

mkdirSync("assets", { recursive: true });
writeFileSync("assets/card.svg", svg);
console.log(
  `${user.login} — ${total} contributions 12M (7D ${up ? "+" : ""}${delta})\n` +
    `mix ${MIX.map(([l, v]) => `${l.toLowerCase()} ${v}`).join(", ")}\n` +
    `langs ${LANGS.map(([l, v]) => `${l} ${pct(v, langTotal)}`).join(", ")}\n` +
    `repos ${user.repositories.totalCount} · ${stars}★ · ${forks} forks · ${(disk / 1024).toFixed(0)} Mo\n` +
    `assets/card.svg (${(svg.length / 1024).toFixed(1)} Ko)`,
);
