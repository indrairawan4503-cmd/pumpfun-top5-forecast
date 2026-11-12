// pumpfun-top5-forecast-01 entry: a Monte Carlo forecaster for the top 5 new
// pump.fun coins by market cap.
//
// Idea (from the practice data, not from the house baseline): pump.fun top
// charts churn violently -- of the top 20 at one 10-minute mark, only ~1 is
// still top-20 forty minutes later, and coins that die collapse to the curve
// floor (~30 SOL). Ten-minute log-cap changes are ~N(0, 0.12) with no usable
// momentum (lag-1 autocorrelation ~ -0.1), so the honest forecast is a
// v2 (2026-11-12): the size law is centred on the LAST mark's top-5 level
// (the all-history mean lags when the level rises -- the practice top-5
// level rose 2.19 -> 3.35 in 40 min) plus a saturating growth shift per
// read horizon, mixed per read; coins are named only when p >= 0.005
// (below the unnamed baseline a named coin scores worse than unnamed).
// Backtest mean log score: -39.47 (v1) -> -35.91 (v2), every cut better.
// v3 (2026-11-12): jump-diffusion (empirical 10-min tails: +1.3%/-2.8% beyond
// 0.3 log), core diffusion capped at 0.10, newcomer ceiling 0.85 -> 0.92 for
// the final window's 7-13 h horizons. Backtest mean: -35.91 -> -35.71.
// v4 (2026-11-12): plateau model. The v2 dev score came back WORSE than v1
// (-39.87 vs -38.63, size -19.81 vs -18.61): the practice level rose during
// the history then plateaued/cooled in the dev reads, and v2's +0.45 growth
// shift overshot it. The final window is a mature 11 h history, so the level
// is at steady state: growth 0.45 -> 0.10, size sd floor 0.35 -> 0.50 to
// hedge drift over 7-13 h. The practice backtest rewards ramp extrapolation
// and will read v4 as worse; the dev score is the honest check.
//
// diffusive one: each coin's log-cap does a random walk with a heavily
// shrunk drift, a per-hour death hazard that drops it to the floor, and
// volatility growing with the square root of the horizon. New coins are born
// constantly (eligible coins grew 235 -> 1434 in 50 practice minutes) and
// regularly take top-5 places within an hour of launch, so a large share of
// every place is deliberately left unnamed for them; that share grows with
// the horizon. One seeded Monte Carlo (fixed seed, fixed draw order) gives
// the place frequencies and the per-place size distributions, averaged over
// the seven answer reads from task.json. Deterministic: two runs on the same
// history write identical bytes.
//
// Node 22, standard library only, no network.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- tunables (fixed in advance, see backtest notes in README) ----
const PATHS = 1000; // Monte Carlo paths
const MAX_CANDIDATES = 2000; // coins simulated (highest last-known caps)
const SEED = 0x9e3779b9; // fixed: deterministic output
const TAU_DRIFT_H = 1.5; // drift saturates over ~this many hours
const DEATH_PER_HOUR_CURVE = 0.2; // hazard a curve coin dies (drops to floor)
const DEATH_PER_HOUR_POOL = 0.18; // hazard a graduated coin dies
const FLOOR_SOL = 30; // dead coins sit at the bonding-curve floor
const JUMP_UP_P = 0.013; // P(+0.3..0.7 log jump) per 10-min step (empirical tail)
const JUMP_DN_P = 0.028; // P(-0.3..0.7 log crash) per 10-min step (empirical tail)
const NEWCOMER_0 = 0.45; // share of a place a newcomer takes at horizon 0
const NEWCOMER_MAX = 0.92; // ... saturating at this share over long horizons
const NEWCOMER_TAU_H = 0.6; // newcomer share grows with this timescale
const MIN_P = 0.005; // smallest named probability per place
const SIZE_SHIFT = 0; // extra constant offset on the newcomer size law mean
const GROWTH_G = 0.1; // saturating growth shift of the top-5 level (log10)
const GROWTH_TAU_H = 0.5; // growth shift timescale (hours)
const SIZE_SD_FLOOR = 0.5; // newcomer size law sd floor
const SIGMA_MIN = 0.08;
const SIGMA_MAX = 0.1; // core diffusion cap (tails come from jumps)
const MICRO = 1_000_000;

interface Row {
  rank: number;
  mint: string;
  market_cap_lamports: string | number;
  venue: string;
  created_at: string;
}

interface Mark {
  at: string;
  rows: Row[] | null;
}

interface Coin {
  mint: string;
  lastLog: number; // log10(cap in SOL) at last sighting
  venue: string; // 'pool' | 'curve' | 'migrating'
  nObs: number;
  meanChange: number; // mean 10-min log change
  drift10: number; // shrunk per-10-min drift (log10 units)
  dead: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One seeded normal draw stream (Box-Muller, deterministic order). */
function makeNormal(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rand() * 2 - 1;
      v = rand() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
}

const floor6 = (p: number): number => Math.floor(p * MICRO) / MICRO;
const log10Sol = (lamports: string | number): number =>
  Math.log10(Number(BigInt(lamports))) - 9;

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places: number;
  reads: string[];
  size: { edges: number[] };
  output: string;
};

const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l !== '');
const marks = lines
  .map((l) => JSON.parse(l) as Mark)
  .filter((m) => Array.isArray(m.rows) && m.rows.length > 0);
if (marks.length === 0) throw new Error('the history holds no mark with rows');

const cutTime = Date.parse(marks[marks.length - 1]!.at);
const horizonsH = task.reads.map((r) => Math.max(0, (Date.parse(r) - cutTime) / 3600000));

// ---- build the coin table from the history ----
const coins = new Map<string, Coin>();
const allChanges: number[] = [];
const top5Logs: number[] = [];
for (let i = 0; i < marks.length; i++) {
  const mark = marks[i]!;
  const prev = new Map<string, number>();
  if (i > 0) {
    for (const r of marks[i - 1]!.rows!) prev.set(r.mint, log10Sol(r.market_cap_lamports));
  }
  for (const r of mark.rows!) {
    const lg = log10Sol(r.market_cap_lamports);
    if (r.rank <= task.places) top5Logs.push(lg);
    let c = coins.get(r.mint);
    if (!c) {
      c = {
        mint: r.mint,
        lastLog: lg,
        venue: r.venue,
        nObs: 0,
        meanChange: 0,
        drift10: 0,
        dead: false,
      };
      coins.set(r.mint, c);
    }
    const p = prev.get(r.mint);
    if (p !== undefined) {
      const d = lg - p;
      allChanges.push(d);
      c.meanChange = (c.meanChange * c.nObs + d) / (c.nObs + 1);
      c.nObs++;
    }
    c.lastLog = lg;
    c.venue = r.venue;
  }
}

// Global 10-minute volatility (pooled sd of consecutive changes).
const meanAll = allChanges.reduce((a, b) => a + b, 0) / Math.max(1, allChanges.length);
const varAll =
  allChanges.reduce((a, b) => a + (b - meanAll) * (b - meanAll), 0) /
  Math.max(1, allChanges.length);
const sigma10 = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, Math.sqrt(varAll)));
const sigmaHour = sigma10 * Math.sqrt(6);

// Per-coin drift: shrunk toward zero, tiny venue bump, clamped.
for (const c of coins.values()) {
  const shrink = (c.nObs / (c.nObs + 6)) * 0.5;
  let d = c.meanChange * shrink;
  d += c.venue === 'pool' ? 0.015 : -0.005;
  c.drift10 = Math.max(-0.03, Math.min(0.03, d));
}

// Candidates: highest last-known caps (they dominate the top-5 race).
const candidates = [...coins.values()]
  .sort((a, b) => b.lastLog - a.lastLog)
  .slice(0, MAX_CANDIDATES);
const n = candidates.length;
if (n < task.places) throw new Error(`only ${n} coins known, fewer than ${task.places} places`);

// Newcomer size distribution: centred on the LAST mark's top-5 level (the
// all-history mean lags badly when the level is rising), plus a saturating
// growth shift per read horizon. Width: the within-mark spread of top-5
// caps, floored -- the across-history spread is inflated by the level ramp.
const lastMarkTop5 = marks[marks.length - 1]!.rows!.slice(0, task.places).map((r) =>
  log10Sol(r.market_cap_lamports),
);
const lastTop5Mean =
  lastMarkTop5.reduce((a, b) => a + b, 0) / Math.max(1, lastMarkTop5.length);
const perMarkSd: number[] = [];
for (const m of marks) {
  const t5 = m.rows!.slice(0, task.places).map((r) => log10Sol(r.market_cap_lamports));
  if (t5.length < 2) continue;
  const mu = t5.reduce((a, b) => a + b, 0) / t5.length;
  perMarkSd.push(Math.sqrt(t5.reduce((a, b) => a + (b - mu) * (b - mu), 0) / t5.length));
}
const sdTop5 = Math.max(
  SIZE_SD_FLOOR,
  perMarkSd.reduce((a, b) => a + b, 0) / Math.max(1, perMarkSd.length),
);
const growthShift = (h: number): number => GROWTH_G * (1 - Math.exp(-h / GROWTH_TAU_H));

// ---- Monte Carlo over the answer reads ----
const nReads = task.reads.length;
const placeCounts: Map<string, number>[] = Array.from(
  { length: task.places },
  () => new Map<string, number>(),
);
const sizeHist: number[][][] = Array.from({ length: nReads }, () =>
  Array.from({ length: task.places }, () => new Array(task.size.edges.length + 1).fill(0)),
);
const binOf = (lg: number): number => {
  const e = task.size.edges;
  if (lg < e[0]!) return 0;
  for (let i = 1; i < e.length; i++) if (lg < e[i]!) return i;
  return e.length;
};

const rand = mulberry32(SEED);
const gauss = makeNormal(rand);
const floorLog = Math.log10(FLOOR_SOL);
const maxLog = Math.max(...candidates.map((c) => c.lastLog));

// Precompute per-read drift increments and death probabilities.
const driftStep: number[][] = []; // [read][coin] incremental drift (log10)
const deathProb: number[][] = []; // [read][coin]
{
  let prevH = 0;
  for (let r = 0; r < nReads; r++) {
    const h = horizonsH[r]!;
    const dRow: number[] = new Array(n);
    const pRow: number[] = new Array(n);
    const driftFactor =
      6 * TAU_DRIFT_H * (Math.exp(-prevH / TAU_DRIFT_H) - Math.exp(-h / TAU_DRIFT_H));
    const dh = Math.max(0, h - prevH);
    for (let i = 0; i < n; i++) {
      const c = candidates[i]!;
      dRow[i] = c.drift10 * driftFactor;
      const lam = c.venue === 'pool' ? DEATH_PER_HOUR_POOL : DEATH_PER_HOUR_CURVE;
      pRow[i] = 1 - Math.exp(-lam * dh);
    }
    driftStep.push(dRow);
    deathProb.push(pRow);
    prevH = h;
  }
}

const simLog = new Float64Array(n);
const simDead = new Uint8Array(n);
for (let path = 0; path < PATHS; path++) {
  for (let i = 0; i < n; i++) {
    simLog[i] = candidates[i]!.lastLog;
    simDead[i] = 0;
  }
  for (let r = 0; r < nReads; r++) {
    const h = horizonsH[r]!;
    const prevH = r === 0 ? 0 : horizonsH[r - 1]!;
    const sig = sigmaHour * Math.sqrt(Math.max(0, h - prevH));
    const dRow = driftStep[r]!;
    const pRow = deathProb[r]!;
    // Advance every coin to this read.
    for (let i = 0; i < n; i++) {
      if (simDead[i]) {
        simLog[i] = floorLog + gauss() * 0.05;
        continue;
      }
      if (rand() < pRow[i]!) {
        simDead[i] = 1;
        simLog[i] = floorLog + gauss() * 0.05;
        continue;
      }
      const u = rand();
      let step: number;
      if (u < JUMP_UP_P) step = 0.3 + rand() * 0.4;
      else if (u < JUMP_UP_P + JUMP_DN_P) step = -(0.3 + rand() * 0.4);
      else step = sig * gauss();
      simLog[i] = simLog[i] + dRow[i]! + step;
    }
    // Top 5 of this read (incremental, no sort).
    const topIdx: number[] = [];
    const topVal: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = simLog[i]!;
      let pos = topIdx.length;
      for (let k = 0; k < topIdx.length; k++) {
        if (v > topVal[k]!) {
          pos = k;
          break;
        }
      }
      if (pos < task.places) {
        topIdx.splice(pos, 0, i);
        topVal.splice(pos, 0, v);
        if (topIdx.length > task.places) {
          topIdx.pop();
          topVal.pop();
        }
      }
    }
    const gShift = growthShift(h);
    for (let k = 0; k < topIdx.length; k++) {
      const mint = candidates[topIdx[k]!]!.mint;
      const pc = placeCounts[k]!;
      pc.set(mint, (pc.get(mint) ?? 0) + 1);
      sizeHist[r]![k]![binOf(topVal[k]! + gShift)]! += 1;
    }
  }
}

// ---- assemble the forecast ----
const total = PATHS * nReads;
const newcomerAvg =
  horizonsH.reduce(
    (a, h) =>
      a + (NEWCOMER_MAX - (NEWCOMER_MAX - NEWCOMER_0) * Math.exp(-h / NEWCOMER_TAU_H)),
    0,
  ) / Math.max(1, nReads);
const namedShare = 1 - newcomerAvg;

interface ProbRow {
  mint: string;
  place: number;
  p: number;
}
const probabilities: ProbRow[] = [];
// Expected-place score for the top5 tie-break.
const coinScore = new Map<string, number>();
for (let k = 0; k < task.places; k++) {
  const pc = placeCounts[k]!;
  const rows: ProbRow[] = [];
  for (const [mint, cnt] of pc) {
    const p = floor6((cnt / total) * namedShare);
    if (p >= MIN_P) {
      rows.push({ mint, place: k + 1, p });
      coinScore.set(mint, (coinScore.get(mint) ?? 0) + p * (task.places + 1 - (k + 1)));
    }
  }
  rows.sort((a, b) => b.p - a.p || (a.mint < b.mint ? -1 : 1));
  probabilities.push(...rows.slice(0, 100));
}
probabilities.sort((a, b) => a.place - b.place || b.p - a.p || (a.mint < b.mint ? -1 : 1));

// top5: best expected-place coins, in order of their strongest place.
const top5 = [...coinScore.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, task.places)
  .map(([mint]) => mint);
if (top5.length < task.places) {
  // Fall back to the last mark's ranking for any missing slot.
  const extra = candidates
    .map((c) => c.mint)
    .filter((m) => !top5.includes(m));
  while (top5.length < task.places && extra.length > 0) top5.push(extra.shift()!);
}

interface SizeRow {
  place: number;
  bin: number;
  p: number;
}
const sizes: SizeRow[] = [];
const edges = task.size.edges;
for (let k = 0; k < task.places; k++) {
  // Mixture over reads: per read, MC place-holder caps (growth-shifted)
  // + newcomer caps ~ Normal(lastTop5Mean + growthShift(h) + SIZE_SHIFT, sdTop5).
  for (let bin = 0; bin <= edges.length; bin++) {
    const lo = bin === 0 ? -Infinity : edges[bin - 1]!;
    const hi = bin === edges.length ? Infinity : edges[bin]!;
    let p = 0;
    for (let r = 0; r < nReads; r++) {
      const h = horizonsH[r]!;
      const nc = NEWCOMER_MAX - (NEWCOMER_MAX - NEWCOMER_0) * Math.exp(-h / NEWCOMER_TAU_H);
      const mcTotal = sizeHist[r]![k]!.reduce((a, b) => a + b, 0) || 1;
      const mcP = sizeHist[r]![k]![bin]! / mcTotal;
      const mu = lastTop5Mean + growthShift(h) + SIZE_SHIFT;
      const zLo = lo === -Infinity ? -Infinity : (lo - mu) / sdTop5;
      const zHi = hi === Infinity ? Infinity : (hi - mu) / sdTop5;
      const ncP = normCdf(zHi) - normCdf(zLo);
      p += ((1 - nc) * mcP + nc * ncP) / nReads;
    }
    p = floor6(p);
    if (p > 0) sizes.push({ place: k + 1, bin, p });
  }
}
sizes.sort((a, b) => a.place - b.place || a.bin - b.bin);

function normCdf(z: number): number {
  if (z === -Infinity) return 0;
  if (z === Infinity) return 1;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  // Abramowitz-Stegun 7.1.26, |eps| < 1.5e-7.
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return s * y;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(
  join(OUTPUT_DIR, task.output),
  `${JSON.stringify({ probabilities, top5, sizes })}\n`,
);
