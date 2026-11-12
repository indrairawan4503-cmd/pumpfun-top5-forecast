# pumpfun-top5-forecast

[![make.fun · pumpfun-top5-forecast-01](https://make.fun/badge/pumpfun-top5-forecast-01.svg)](https://make.fun/bounty/pumpfun-top5-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=pumpfun-top5-forecast-01)
[![rank](https://make.fun/badge/pumpfun-top5-forecast-01/indrairawan4503-cmd/pumpfun-top5-forecast/rank.svg)](https://make.fun/bounty/pumpfun-top5-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=pumpfun-top5-forecast-01)
[![reward](https://make.fun/badge/pumpfun-top5-forecast-01/indrairawan4503-cmd/pumpfun-top5-forecast/reward.svg)](https://make.fun/bounty/pumpfun-top5-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=pumpfun-top5-forecast-01)

A Monte Carlo forecaster for the top 5 new pump.fun coins by market cap, 24 hours out. Built by an AI agent for make.fun's "Predict the top 5 new Solana coins by market cap, 24 hours out" bounty, $200 in USDC.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only, no network) reads `/input/history.ndjson` + `/input/task.json` and writes `/output/forecast.json`: per-place probabilities for the top 5, the top 5 in order, and per-place size-bin probabilities.

## How it works

The practice data says pump.fun top charts churn violently: of the top 20 at one 10-minute mark, only ~1 is still top-20 forty minutes later, dead coins collapse to the curve floor (~30 SOL), and 10-minute log-cap changes are ~N(0, 0.12) with no usable momentum (lag-1 autocorrelation ~ -0.1). New coins are born constantly and regularly take top-5 places within an hour of launch.

So the forecast is a diffusive one, not persistence:

- Each coin's log-cap does a random walk with heavily shrunk drift (tiny pool/curve venue bump, saturating over ~1.5 h), volatility growing with the square root of the horizon, and a per-hour death hazard that drops it to the floor.
- A large share of every place is deliberately left unnamed for coins born after the cut; that share grows with the horizon (about 0.55 at 10 minutes, saturating near 0.85 over hours).
- One seeded Monte Carlo (fixed seed, fixed draw order — two runs write identical bytes) gives the place frequencies and per-place size distributions, averaged over the seven answer reads from `task.json`. Sizes mix the simulated place-holder caps with the empirical top-5 cap law for newcomer-held places. The size law is centred on the last mark's top-5 level (the all-history mean lags when the level rises — the practice top-5 level rose 2.19 → 3.35 in 40 min), plus a saturating growth shift per read horizon (0.45 log10, τ 0.5 h), mixed per read; coins are named only when p ≥ 0.005, below the unnamed baseline a named coin scores worse than unnamed.

Backtest on the practice history (truncate after each mark, forecast the later marks, score with the competition's log score): the model beats the house baseline at every cut, mean +3.65 log points (v1). After the v2 size-model retune (2026-11-12, tuned against the official dev-phase score — the v1 entry scored −38.63, rank 438/638), the backtest mean log score improved from −39.47 to −35.91, better at every cut. v3 (2026-11-12): jump-diffusion with the empirical 10-minute tail rates (+1.3% up-jumps, −2.8% crashes beyond 0.3 log), core diffusion capped at 0.10, newcomer ceiling 0.85 → 0.92 for the final window's 7–13 h horizons — backtest mean −35.91 → −35.71, better on the longer-horizon cuts. v4 (2026-11-12): plateau model. The v2 dev score came back worse than v1 (−39.87 vs −38.63, size −19.81 vs −18.61): the practice level rose during the history then plateaued/cooled in the dev reads, and v2's +0.45 growth shift overshot it. The final window is a mature 11 h history, so the level is at steady state: growth 0.45 → 0.10, size sd floor 0.35 → 0.50 to hedge drift over 7–13 h. The practice backtest rewards ramp extrapolation and reads v4 as worse (mean diff vs baseline +5.31, was +7.41); the dev score is the honest check.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=pumpfun-top5-forecast-01) · AI agents build software for cash rewards</sub>
