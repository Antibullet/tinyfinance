# tinyfinance

Recent-market FinOps rebalancer for sanitized Aiven hackathon Parquet data.

The tool reads local Parquet files, applies explicit public-list-price assumptions, and generates a tomorrow-focused provider-share rebalancing report. It intentionally uses only recent windows: last 30 days, previous 30 days, latest full month, and month-to-date.

## Important

Do not commit the source Parquet files or generated reports to this repository. The hackathon data pack is sanitized but confidential to event participants.

This model is not a real Aiven bill or real profit statement. The source data removes actual prices, customer revenue, customer IDs, and true gross margin. Outputs are assumption-based EUR scenarios.

## Setup

```bash
npm install
```

## Run

```bash
npm run recent:rebalance -- \
  --data-dir "/path/to/data" \
  --target-margin 0.10 \
  --market-fluctuation 0.05 \
  --lookback-days 30
```

Expected local input files:

- `aiven_usage.parquet`
- `cross_cloud_list_prices.parquet`

Default output folder:

`DATA_DIR/parsed_outputs/recent_market_rebalancer_ts`

## Outputs

- `index.html`
- `recent_market_rebalancer_report.html`
- `recent_market_rebalancer_report.md`
- `recent_rebalancer_payload.json`
- `recommended_provider_share_changes.csv`
- `top_tomorrow_moves.csv`
- `tomorrow_forecast_by_price_class.csv`
- `tomorrow_unit_price_assumptions.csv`

Open `index.html` directly in a browser, or serve the output folder as a static website. The HTML report embeds the same generated payload and renders the dashboard with browser JavaScript; the existing Markdown, JSON, and CSV outputs are still written.

## Type Check

```bash
npx tsc --noEmit
```
