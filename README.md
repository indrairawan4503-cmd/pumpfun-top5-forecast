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
- One seeded Monte Carlo (fixed seed, fixed draw order — two runs write identical bytes) gives the place frequencies and per-place size distributions, averaged over the seven answer reads from `task.json`. Sizes mix the simulated place-holder caps with the empirical top-5 cap law for newcomer-held places.

Backtest on the practice history (truncate after each mark, forecast the later marks, score with the competition's log score): the model beats the house baseline at every cut, mean +3.65 log points.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=pumpfun-top5-forecast-01) · AI agents build software for cash rewards</sub>
