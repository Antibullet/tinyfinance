import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const duckdb = require("duckdb");

const RATIO_PRICE_SOURCE_NOTE = "cross_cloud_list_prices.parquet p50_ratio; missing ratios default to 1.0 like AIEVEN";

type RatioPrice = {
  cloud: string;
  geoBucket: string;
  skuFamily: string;
  unit: string;
  p25Ratio: number | null;
  p50Ratio: number;
  p75Ratio: number | null;
  sourceNote: string;
};

type ForecastRow = {
  currentCloud: string;
  targetCloud: string;
  priceClass: string;
  forecastUnits: number;
  currentRatio: number;
  targetRatio: number;
  currentCostRatioUnits: number;
  optimizedCostRatioUnits: number;
  savingsRatioUnits: number;
};

type ShareRow = {
  cloud: string;
  currentWorkloadValueRatioUnits: number;
  currentWorkloadSharePct: number;
  targetWorkloadValueRatioUnits: number;
  targetWorkloadSharePct: number;
  workloadShareDeltaPctPoints: number;
  currentCostRatioUnits: number;
  optimizedCostRatioUnits: number;
  optimizedCostSharePct: number;
};

type ForecastSummary = {
  forecastCurrentCostRatioUnits: number;
  forecastLowMarketCostRatioUnits: number;
  forecastHighMarketCostRatioUnits: number;
  forecastOptimizedCostRatioUnits: number;
  forecastSavingsRatioUnits: number;
  requiredRevenueFor10PctMarginRatioUnits: number;
  profitAt10PctMarginRatioUnits: number;
  optimizedMarginPctIfRevenueUnchanged: number;
};

type ReportOutput = {
  generatedAt: string;
  scope: {
    maxObservedDate: string;
    forecastDate: string;
    lookbackDays: number;
    targetMargin: number;
    marketFluctuation: number;
    ewmaAlpha: number;
  };
  warning: string;
  forecastSummary: ForecastSummary;
  recommendedShareChanges: ShareRow[];
  topMoves: ForecastRow[];
  tomorrowForecast: ForecastRow[];
  windowSummary: Record<string, unknown>[];
  latestDay: Record<string, unknown>[];
};

type Args = {
  dataDir: string;
  outDir: string;
  targetMargin: number;
  marketFluctuation: number;
  lookbackDays: number;
  ewmaAlpha: number;
};

class DuckDB {
  private readonly db: any;
  private readonly con: any;

  constructor() {
    this.db = new duckdb.Database(":memory:");
    this.con = this.db.connect();
  }

  all<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.con.all(sql, (err: Error | null, rows: T[]) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  run(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.con.run(sql, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outDir, { recursive: true });

  const usagePath = path.join(args.dataDir, "aiven_usage.parquet");
  const pricesPath = path.join(args.dataDir, "cross_cloud_list_prices.parquet");
  const db = new DuckDB();
  await setupTables(db, pricesPath);
  await createCostedView(db, usagePath);

  const bounds = await db.all<{ max_date: string; current_month_start: string; latest_full_month_start: string }>(`
    SELECT
      CAST(max(status_date) AS VARCHAR) AS max_date,
      CAST(date_trunc('month', max(status_date)) AS VARCHAR) AS current_month_start,
      CAST(date_trunc('month', max(status_date) - INTERVAL 1 MONTH) AS VARCHAR) AS latest_full_month_start
    FROM read_parquet('${sqlString(usagePath)}')
  `);
  const maxDate = String(bounds[0]?.max_date ?? "unknown");
  const forecastDate = await db.all<{ forecast_date: string }>(`
    SELECT CAST((max(status_date)::DATE + INTERVAL 1 DAY) AS VARCHAR) AS forecast_date
    FROM read_parquet('${sqlString(usagePath)}')
  `);
  const tomorrow = String(forecastDate[0]?.forecast_date ?? "tomorrow");

  const windowSummary = await db.all<Record<string, unknown>>(windowSummarySql(args));
  const latestDay = await db.all<Record<string, unknown>>(latestDaySql(args));
  const dailyRows = await db.all<Record<string, unknown>>(dailyPriceClassSql(args));

  const forecastRows = buildForecastRows(dailyRows, args.lookbackDays, args.ewmaAlpha);
  const shareRows = buildShareRows(forecastRows);
  const summary = buildForecastSummary(forecastRows, args);
  const topMoves = forecastRows
    .filter((row) => row.savingsRatioUnits > 0.01)
    .sort((a, b) => b.savingsRatioUnits - a.savingsRatioUnits)
    .slice(0, 30);

  const ratioPricesForTomorrow = await db.all<RatioPrice>(ratioPriceCatalogSql(args));

  const output: ReportOutput = {
    generatedAt: new Date().toISOString(),
    scope: {
      maxObservedDate: maxDate,
      forecastDate: tomorrow,
      lookbackDays: args.lookbackDays,
      targetMargin: args.targetMargin,
      marketFluctuation: args.marketFluctuation,
      ewmaAlpha: args.ewmaAlpha,
    },
    warning: "This is an assumption model. Costs are ratio-weighted units from sanitized/noised amounts, not EUR invoices or real Aiven revenue.",
    forecastSummary: summary,
    recommendedShareChanges: shareRows,
    topMoves,
    tomorrowForecast: forecastRows,
    windowSummary,
    latestDay,
  };

  const markdownReportPath = path.join(args.outDir, "recent_market_rebalancer_report.md");
  const htmlReportPath = path.join(args.outDir, "recent_market_rebalancer_report.html");
  const htmlIndexPath = path.join(args.outDir, "index.html");
  const htmlReport = buildHtmlReport(output, args);

  await writeCsv(path.join(args.outDir, "recent_window_summary.csv"), windowSummary);
  await writeCsv(path.join(args.outDir, "latest_day_by_cloud.csv"), latestDay);
  await writeCsv(path.join(args.outDir, "tomorrow_forecast_by_price_class.csv"), forecastRows);
  await writeCsv(path.join(args.outDir, "recommended_cloud_share_changes.csv"), shareRows);
  await writeCsv(path.join(args.outDir, "top_tomorrow_moves.csv"), topMoves);
  await writeCsv(path.join(args.outDir, "tomorrow_ratio_price_assumptions.csv"), ratioPricesForTomorrow);
  await writeFile(path.join(args.outDir, "recent_rebalancer_payload.json"), JSON.stringify(output, jsonReplacer, 2), "utf8");
  await writeFile(markdownReportPath, buildReport(output, args), "utf8");
  await writeFile(htmlReportPath, htmlReport, "utf8");
  await writeFile(htmlIndexPath, htmlReport, "utf8");

  console.log("Created recent-market TypeScript rebalancing report");
  console.log(`Output folder: ${args.outDir}`);
  console.log(`Markdown report: ${markdownReportPath}`);
  console.log(`HTML website: ${htmlReportPath}`);
  console.log(`Forecast date: ${tomorrow}`);
  console.log(`Forecast base ratio units: ${formatRatioUnits(summary.forecastCurrentCostRatioUnits)}`);
  console.log(`Forecast optimized ratio units: ${formatRatioUnits(summary.forecastOptimizedCostRatioUnits)}`);
  console.log(`Forecast savings ratio units: ${formatRatioUnits(summary.forecastSavingsRatioUnits)}`);
}

function parseArgs(argv: string[]): Args {
  const defaults = {
    dataDir: process.cwd(),
    outDir: "",
    targetMargin: 0.10,
    marketFluctuation: 0.05,
    lookbackDays: 30,
    ewmaAlpha: 0.35,
  };
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    parsed[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  const dataDir = path.resolve(parsed["data-dir"] ?? defaults.dataDir);
  return {
    dataDir,
    outDir: path.resolve(parsed["out-dir"] ?? path.join(dataDir, "parsed_outputs", "recent_market_rebalancer_ts")),
    targetMargin: Number(parsed["target-margin"] ?? defaults.targetMargin),
    marketFluctuation: Number(parsed["market-fluctuation"] ?? defaults.marketFluctuation),
    lookbackDays: Number(parsed["lookback-days"] ?? defaults.lookbackDays),
    ewmaAlpha: Number(parsed["ewma-alpha"] ?? defaults.ewmaAlpha),
  };
}

async function setupTables(db: DuckDB, pricesPath: string) {
  await db.run(`
    CREATE OR REPLACE TEMP VIEW price_catalog AS
    SELECT cloud,
           geo_bucket,
           sku_family,
           ${normalizedUnitSql("unit")} AS unit_n,
           p25_ratio,
           p50_ratio,
           p75_ratio,
           ${sqlValue(RATIO_PRICE_SOURCE_NOTE)} AS source_note
    FROM read_parquet('${sqlString(pricesPath)}')
    WHERE p50_ratio IS NOT NULL
  `);
}

async function createCostedView(db: DuckDB, usagePath: string) {
  await db.run(`
    CREATE OR REPLACE TEMP VIEW costed AS
    WITH usage_normalized AS (
      SELECT u.*,
             ${normalizedUnitSql("u.unit")} AS unit_n,
             concat(u.geo_bucket, '/', u.sku_family, '/', ${normalizedUnitSql("u.unit")}) AS price_class,
             u.amount AS billable_units
      FROM read_parquet('${sqlString(usagePath)}') u
    ),
    baseline_catalog AS (
      SELECT DISTINCT 'cloud_a' AS cloud,
             geo_bucket,
             sku_family,
             unit_n,
             CAST(NULL AS DOUBLE) AS p25_ratio,
             1.0 AS p50_ratio,
             CAST(NULL AS DOUBLE) AS p75_ratio,
             'implied cloud_a baseline ratio' AS source_note
      FROM usage_normalized
    ),
    catalog AS (
      SELECT cloud, geo_bucket, sku_family, unit_n, p25_ratio, p50_ratio, p75_ratio, source_note
      FROM price_catalog
      UNION ALL
      SELECT b.cloud, b.geo_bucket, b.sku_family, b.unit_n, b.p25_ratio, b.p50_ratio, b.p75_ratio, b.source_note
      FROM baseline_catalog b
      WHERE NOT EXISTS (
        SELECT 1
        FROM price_catalog p
        WHERE p.cloud = b.cloud
          AND p.geo_bucket = b.geo_bucket
          AND p.sku_family = b.sku_family
          AND p.unit_n = b.unit_n
      )
    ),
    current_priced AS (
      SELECT u.*,
             pc.p50_ratio AS catalog_p50_ratio,
             coalesce(pc.p50_ratio, 1.0) AS current_ratio,
             pc.source_note AS ratio_source_note
      FROM usage_normalized u
      LEFT JOIN catalog pc USING (cloud, geo_bucket, sku_family, unit_n)
    ),
    cheapest AS (
      SELECT cloud AS cheapest_cloud, geo_bucket, sku_family, unit_n, p50_ratio AS cheapest_ratio
      FROM (
        SELECT *, row_number() OVER (PARTITION BY geo_bucket, sku_family, unit_n ORDER BY p50_ratio ASC, cloud ASC) AS rn
        FROM catalog
      )
      WHERE rn = 1
    )
    SELECT c.*,
           c.cloud AS current_cloud,
           ch.cheapest_cloud,
           ch.cheapest_ratio,
           CASE
             WHEN c.sku_family = 'commitment-discount' OR c.billable_units IS NULL THEN NULL
             ELSE c.billable_units * c.current_ratio
           END AS current_cost_ratio_units,
           CASE
             WHEN c.sku_family = 'commitment-discount' OR c.billable_units IS NULL THEN NULL
             WHEN ch.cheapest_ratio IS NOT NULL AND ch.cheapest_cloud <> c.cloud AND ch.cheapest_ratio < c.current_ratio THEN c.billable_units * ch.cheapest_ratio
             ELSE c.billable_units * c.current_ratio
           END AS optimized_cost_ratio_units,
           CASE
             WHEN c.sku_family = 'commitment-discount' OR c.billable_units IS NULL THEN NULL
             WHEN ch.cheapest_ratio IS NOT NULL AND ch.cheapest_cloud <> c.cloud AND ch.cheapest_ratio < c.current_ratio THEN greatest((c.billable_units * c.current_ratio) - (c.billable_units * ch.cheapest_ratio), 0)
             ELSE 0
           END AS theoretical_savings_ratio_units
    FROM current_priced c
    LEFT JOIN cheapest ch USING (geo_bucket, sku_family, unit_n)
  `);
}

function ratioPriceCatalogSql(_args: Args): string {
  return `
    SELECT cloud,
           geo_bucket AS geoBucket,
           sku_family AS skuFamily,
           unit_n AS unit,
           round(p25_ratio, 6) AS p25Ratio,
           round(p50_ratio, 6) AS p50Ratio,
           round(p75_ratio, 6) AS p75Ratio,
           source_note AS sourceNote
    FROM price_catalog
    ORDER BY cloud, geo_bucket, sku_family, unit_n
  `;
}

function windowSummarySql(args: Args): string {
  return `
    WITH bounds AS (
      SELECT max(status_date)::DATE AS max_date,
             date_trunc('month', max(status_date))::DATE AS current_month_start,
             date_trunc('month', max(status_date) - INTERVAL 1 MONTH)::DATE AS latest_full_month_start
      FROM costed
    ),
    windows AS (
      SELECT 'last_30_days' AS window_name, max_date - (${args.lookbackDays - 1} * INTERVAL 1 DAY) AS start_date, max_date AS end_date FROM bounds
      UNION ALL SELECT 'previous_30_days', max_date - (${args.lookbackDays * 2 - 1} * INTERVAL 1 DAY), max_date - (${args.lookbackDays} * INTERVAL 1 DAY) FROM bounds
      UNION ALL SELECT 'latest_full_month', latest_full_month_start, current_month_start - INTERVAL 1 DAY FROM bounds
      UNION ALL SELECT 'month_to_date', current_month_start, max_date FROM bounds
    )
    SELECT w.window_name,
           CAST(w.start_date AS VARCHAR) AS start_date,
           CAST(w.end_date AS VARCHAR) AS end_date,
           count(c.line_id) AS total_rows,
           count(c.line_id) FILTER (WHERE c.catalog_p50_ratio IS NOT NULL) AS catalog_price_rows,
           round(100.0 * count(c.line_id) FILTER (WHERE c.catalog_p50_ratio IS NOT NULL) / nullif(count(c.line_id), 0), 2) AS catalog_price_row_pct,
           round(coalesce(sum(c.current_cost_ratio_units), 0), 2) AS modeled_cost_ratio_units,
           round(coalesce(sum(c.current_cost_ratio_units), 0) * (1 - ${args.marketFluctuation}), 2) AS low_market_cost_ratio_units,
           round(coalesce(sum(c.current_cost_ratio_units), 0) * (1 + ${args.marketFluctuation}), 2) AS high_market_cost_ratio_units,
           round(coalesce(sum(c.theoretical_savings_ratio_units), 0), 2) AS theoretical_savings_ratio_units,
           round(coalesce(sum(c.optimized_cost_ratio_units), 0), 2) AS optimized_cost_ratio_units,
           round(coalesce(sum(c.current_cost_ratio_units), 0) / (1 - ${args.targetMargin}), 2) AS revenue_required_for_target_margin_ratio_units,
           round((coalesce(sum(c.current_cost_ratio_units), 0) / (1 - ${args.targetMargin})) - coalesce(sum(c.current_cost_ratio_units), 0), 2) AS profit_at_target_margin_ratio_units,
           round(100.0 * ((coalesce(sum(c.current_cost_ratio_units), 0) / (1 - ${args.targetMargin})) - coalesce(sum(c.optimized_cost_ratio_units), 0)) / nullif(coalesce(sum(c.current_cost_ratio_units), 0) / (1 - ${args.targetMargin}), 0), 2) AS margin_after_savings_pct,
           round(coalesce(sum(CASE WHEN c.sku_family = 'commitment-discount' THEN c.amount ELSE 0 END), 0), 2) AS excluded_commitment_raw_amount,
           round(coalesce(sum(CASE WHEN c.catalog_p50_ratio IS NULL AND c.sku_family <> 'commitment-discount' THEN c.amount ELSE 0 END), 0), 2) AS default_ratio_raw_amount
    FROM windows w
    LEFT JOIN costed c ON c.status_date::DATE >= w.start_date AND c.status_date::DATE <= w.end_date
    GROUP BY 1,2,3
    ORDER BY CASE w.window_name WHEN 'last_30_days' THEN 1 WHEN 'previous_30_days' THEN 2 WHEN 'latest_full_month' THEN 3 ELSE 4 END
  `;
}

function latestDaySql(args: Args): string {
  return `
    WITH bounds AS (SELECT max(status_date)::DATE AS max_date FROM costed)
    SELECT CAST(c.status_date AS VARCHAR) AS status_date,
           c.cloud,
           count(*) AS total_rows,
           count(*) FILTER (WHERE c.catalog_p50_ratio IS NOT NULL) AS catalog_price_rows,
           round(coalesce(sum(c.current_cost_ratio_units), 0), 2) AS modeled_cost_ratio_units,
           round(coalesce(sum(c.current_cost_ratio_units), 0) * (1 - ${args.marketFluctuation}), 2) AS low_market_cost_ratio_units,
           round(coalesce(sum(c.current_cost_ratio_units), 0) * (1 + ${args.marketFluctuation}), 2) AS high_market_cost_ratio_units,
           round(coalesce(sum(c.theoretical_savings_ratio_units), 0), 2) AS theoretical_savings_ratio_units,
           round(coalesce(sum(c.optimized_cost_ratio_units), 0), 2) AS optimized_cost_ratio_units
    FROM costed c
    JOIN bounds b ON c.status_date::DATE = b.max_date
    GROUP BY 1,2
    ORDER BY modeled_cost_ratio_units DESC
  `;
}

function dailyPriceClassSql(args: Args): string {
  return `
    WITH bounds AS (SELECT max(status_date)::DATE AS max_date FROM costed)
    SELECT CAST(c.status_date::DATE AS VARCHAR) AS status_date,
           c.cloud AS current_cloud,
           c.price_class,
           c.cheapest_cloud,
           avg(c.current_ratio) AS current_ratio,
           avg(c.cheapest_ratio) AS cheapest_ratio,
           round(sum(c.billable_units), 8) AS billable_units,
           round(sum(c.current_cost_ratio_units), 8) AS current_cost_ratio_units,
           round(sum(c.theoretical_savings_ratio_units), 8) AS theoretical_savings_ratio_units
    FROM costed c
    JOIN bounds b ON c.status_date::DATE >= b.max_date - (${args.lookbackDays - 1} * INTERVAL 1 DAY)
    WHERE c.current_cost_ratio_units IS NOT NULL
    GROUP BY 1,2,3,4
    ORDER BY 1,2,3
  `;
}

function buildForecastRows(rows: Record<string, unknown>[], lookbackDays: number, alpha: number): ForecastRow[] {
  const dates = [...new Set(rows.map((row) => String(row.status_date)))].sort();
  const keys = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = `${row.current_cloud}|||${row.price_class}|||${row.cheapest_cloud}`;
    const list = keys.get(key) ?? [];
    list.push(row);
    keys.set(key, list);
  }

  const result: ForecastRow[] = [];
  for (const [key, keyRows] of keys) {
    const [currentCloud, priceClass, cheapestCloud] = key.split("|||");
    const byDate = new Map(keyRows.map((row) => [String(row.status_date), row]));
    const currentRatio = numberValue(keyRows.find((row) => row.current_ratio !== null)?.current_ratio);
    const cheapestRatio = numberValue(keyRows.find((row) => row.cheapest_ratio !== null)?.cheapest_ratio);
    let ewmaUnits = 0;
    let initialized = false;
    for (const date of dates.slice(-lookbackDays)) {
      const units = numberValue(byDate.get(date)?.billable_units);
      if (!initialized) {
        ewmaUnits = units;
        initialized = true;
      } else {
        ewmaUnits = alpha * units + (1 - alpha) * ewmaUnits;
      }
    }
    const targetCloud = currentRatio > cheapestRatio ? cheapestCloud : currentCloud;
    const targetRatio = currentRatio > cheapestRatio ? cheapestRatio : currentRatio;
    const currentCost = ewmaUnits * currentRatio;
    const optimizedCost = ewmaUnits * targetRatio;
    result.push({
      currentCloud,
      targetCloud,
      priceClass,
      forecastUnits: ewmaUnits,
      currentRatio,
      targetRatio,
      currentCostRatioUnits: currentCost,
      optimizedCostRatioUnits: optimizedCost,
      savingsRatioUnits: Math.max(currentCost - optimizedCost, 0),
    });
  }
  return result.sort((a, b) => b.savingsRatioUnits - a.savingsRatioUnits);
}

function buildForecastSummary(rows: ForecastRow[], args: Args): ForecastSummary {
  const current = sum(rows.map((row) => row.currentCostRatioUnits));
  const optimized = sum(rows.map((row) => row.optimizedCostRatioUnits));
  const savings = current - optimized;
  const revenueRequired = current / (1 - args.targetMargin);
  const optimizedMargin = revenueRequired > 0 ? ((revenueRequired - optimized) / revenueRequired) * 100 : 0;
  return {
    forecastCurrentCostRatioUnits: round(current),
    forecastLowMarketCostRatioUnits: round(current * (1 - args.marketFluctuation)),
    forecastHighMarketCostRatioUnits: round(current * (1 + args.marketFluctuation)),
    forecastOptimizedCostRatioUnits: round(optimized),
    forecastSavingsRatioUnits: round(savings),
    requiredRevenueFor10PctMarginRatioUnits: round(revenueRequired),
    profitAt10PctMarginRatioUnits: round(revenueRequired - current),
    optimizedMarginPctIfRevenueUnchanged: round(optimizedMargin),
  };
}

function buildShareRows(rows: ForecastRow[]): ShareRow[] {
  const clouds = new Set<string>();
  const currentValue = new Map<string, number>();
  const targetValue = new Map<string, number>();
  const currentCost = new Map<string, number>();
  const optimizedCost = new Map<string, number>();

  for (const row of rows) {
    clouds.add(row.currentCloud);
    clouds.add(row.targetCloud);
    currentValue.set(row.currentCloud, (currentValue.get(row.currentCloud) ?? 0) + row.currentCostRatioUnits);
    currentCost.set(row.currentCloud, (currentCost.get(row.currentCloud) ?? 0) + row.currentCostRatioUnits);
    targetValue.set(row.targetCloud, (targetValue.get(row.targetCloud) ?? 0) + row.currentCostRatioUnits);
    optimizedCost.set(row.targetCloud, (optimizedCost.get(row.targetCloud) ?? 0) + row.optimizedCostRatioUnits);
  }

  const currentValueTotal = sum([...currentValue.values()]);
  const targetValueTotal = sum([...targetValue.values()]);
  const optimizedCostTotal = sum([...optimizedCost.values()]);
  return [...clouds]
    .map((cloud) => {
      const currentVal = currentValue.get(cloud) ?? 0;
      const targetVal = targetValue.get(cloud) ?? 0;
      const currentShare = pct(currentVal, currentValueTotal);
      const targetShare = pct(targetVal, targetValueTotal);
      return {
        cloud,
        currentWorkloadValueRatioUnits: round(currentVal),
        currentWorkloadSharePct: round(currentShare),
        targetWorkloadValueRatioUnits: round(targetVal),
        targetWorkloadSharePct: round(targetShare),
        workloadShareDeltaPctPoints: round(targetShare - currentShare),
        currentCostRatioUnits: round(currentCost.get(cloud) ?? 0),
        optimizedCostRatioUnits: round(optimizedCost.get(cloud) ?? 0),
        optimizedCostSharePct: round(pct(optimizedCost.get(cloud) ?? 0, optimizedCostTotal)),
      };
    })
    .sort((a, b) => Math.abs(b.workloadShareDeltaPctPoints) - Math.abs(a.workloadShareDeltaPctPoints));
}

function buildReport(output: ReportOutput, args: Args): string {
  const summary = output.forecastSummary;
  const last30 = output.windowSummary.find((row: any) => row.window_name === "last_30_days");
  const previous30 = output.windowSummary.find((row: any) => row.window_name === "previous_30_days");
  const latestFullMonth = output.windowSummary.find((row: any) => row.window_name === "latest_full_month");
  const monthToDate = output.windowSummary.find((row: any) => row.window_name === "month_to_date");
  const shareRows = output.recommendedShareChanges as ShareRow[];
  const topMoves = output.topMoves as ForecastRow[];

  return [
    "# Recent Market Rebalancer Report",
    "",
    "## Scope",
    `- Latest observed date in Parquet: **${output.scope.maxObservedDate}**.`,
    `- Forecast date: **${output.scope.forecastDate}**.`,
    `- Recency window: last **${args.lookbackDays} days**, compared with previous **${args.lookbackDays} days** only.`,
    `- Target gross margin: **${formatPct(args.targetMargin * 100)}**.`,
    `- Market fluctuation band: **+/-${formatPct(args.marketFluctuation * 100)}**.`,
    "- Prices are AIEVEN-style p50 ratios from `cross_cloud_list_prices.parquet`; costs are ratio-weighted units, not currency.",
    "- Missing ratios default to 1.0, matching the AIEVEN optimizer's baseline behavior.",
    "",
    "## Recent Cost View",
    `- Last ${args.lookbackDays} days modeled cost: **${formatRatioUnits(last30?.modeled_cost_ratio_units)}**; theoretical savings: **${formatRatioUnits(last30?.theoretical_savings_ratio_units)}**; optimized cost: **${formatRatioUnits(last30?.optimized_cost_ratio_units)}**.`,
    `- Previous ${args.lookbackDays} days modeled cost: **${formatRatioUnits(previous30?.modeled_cost_ratio_units)}**; theoretical savings: **${formatRatioUnits(previous30?.theoretical_savings_ratio_units)}**.`,
    `- Latest full month modeled cost: **${formatRatioUnits(latestFullMonth?.modeled_cost_ratio_units)}**; low-market case: **${formatRatioUnits(latestFullMonth?.low_market_cost_ratio_units)}**.`,
    `- Month-to-date modeled cost: **${formatRatioUnits(monthToDate?.modeled_cost_ratio_units)}**; theoretical savings: **${formatRatioUnits(monthToDate?.theoretical_savings_ratio_units)}**.`,
    "",
    "## Tomorrow Forecast",
    `- Base forecast cost: **${formatRatioUnits(summary.forecastCurrentCostRatioUnits)}**.`,
    `- Low market case (-${formatPct(args.marketFluctuation * 100)}): **${formatRatioUnits(summary.forecastLowMarketCostRatioUnits)}**.`,
    `- High market case (+${formatPct(args.marketFluctuation * 100)}): **${formatRatioUnits(summary.forecastHighMarketCostRatioUnits)}**.`,
    `- Required revenue-equivalent for 10% gross margin: **${formatRatioUnits(summary.requiredRevenueFor10PctMarginRatioUnits)}**.`,
    `- Profit-equivalent at 10% gross margin before changes: **${formatRatioUnits(summary.profitAt10PctMarginRatioUnits)}**.`,
    `- Optimized cost after recommended full reroute: **${formatRatioUnits(summary.forecastOptimizedCostRatioUnits)}**.`,
    `- Forecast savings: **${formatRatioUnits(summary.forecastSavingsRatioUnits)}**.`,
    `- Margin after changes if revenue stays fixed: **${formatPct(summary.optimizedMarginPctIfRevenueUnchanged)}**.`,
    "",
    "## Share Changes Needed",
    "Workload share is measured on current ratio-weighted cost value, because raw units mix GB, GiB-hour, VM-hours, IP-hours, and storage months.",
    ...shareRows.map((row) => `- **${row.cloud}**: ${formatPct(row.currentWorkloadSharePct)} -> ${formatPct(row.targetWorkloadSharePct)} workload-value share (${signed(row.workloadShareDeltaPctPoints)} pts); optimized cost share ${formatPct(row.optimizedCostSharePct)}.`),
    "",
    "## Top Tomorrow Moves",
    ...topMoves.slice(0, 15).map((row) => `- Move **${row.priceClass}** from **${row.currentCloud}** to **${row.targetCloud}**: forecast units ${formatNumber(row.forecastUnits)}, cost ${formatRatioUnits(row.currentCostRatioUnits)} -> ${formatRatioUnits(row.optimizedCostRatioUnits)}, save **${formatRatioUnits(row.savingsRatioUnits)}**.`),
    "",
    "## Caveats",
    "- This is not real profit margin. It estimates the revenue-equivalent needed to hit a 10% target margin because Aiven customer revenue is absent.",
    "- The model only uses the latest recency window. It intentionally ignores older history except the previous comparable window.",
    "- The model ignores migration cost, compliance, latency, customer cloud preference, capacity reservations, and support obligations.",
    "- Cloud labels are anonymized IDs from the sanitized input, not public provider names.",
    "",
    "## Files",
    `- Payload: \`${path.join(args.outDir, "recent_rebalancer_payload.json")}\``,
    `- Share changes: \`${path.join(args.outDir, "recommended_cloud_share_changes.csv")}\``,
    `- Top moves: \`${path.join(args.outDir, "top_tomorrow_moves.csv")}\``,
    `- Tomorrow forecast: \`${path.join(args.outDir, "tomorrow_forecast_by_price_class.csv")}\``,
    `- Ratio price assumptions: \`${path.join(args.outDir, "tomorrow_ratio_price_assumptions.csv")}\``,
    "",
  ].join("\n");
}

function buildHtmlReport(output: ReportOutput, args: Args): string {
  const dataJson = safeJsonForScript(JSON.stringify(output, jsonReplacer) ?? "{}");
  const generatedAt = escapeHtml(formatGeneratedAt(output.generatedAt));
  const lookbackDays = escapeHtml(args.lookbackDays);
  const targetMargin = escapeHtml(formatPct(args.targetMargin * 100));
  const marketFluctuation = escapeHtml(formatPct(args.marketFluctuation * 100));

  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tinyfinance Recent Market Rebalancer</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #06111f;
      --bg-2: #0a1728;
      --surface: rgba(13, 29, 48, 0.88);
      --surface-strong: #10223a;
      --surface-soft: rgba(255, 255, 255, 0.06);
      --text: #f6f8ff;
      --muted: #aab8cc;
      --line: rgba(210, 226, 255, 0.16);
      --green: #c7ff4f;
      --green-strong: #9cff00;
      --blue: #80d7ff;
      --pink: #ff8fd4;
      --orange: #ffbf69;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      --radius: 28px;
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      min-width: 320px;
      background:
        radial-gradient(circle at 8% 8%, rgba(128, 215, 255, 0.22), transparent 34rem),
        radial-gradient(circle at 92% 0%, rgba(199, 255, 79, 0.2), transparent 28rem),
        linear-gradient(180deg, var(--bg), #030914 58%, #020711);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }

    a { color: inherit; text-decoration: none; }

    :focus-visible {
      outline: 3px solid #ffffff;
      outline-offset: 4px;
    }

    .skip-link {
      position: absolute;
      left: 16px;
      top: 12px;
      z-index: 40;
      transform: translateY(-160%);
      padding: 10px 14px;
      border-radius: 999px;
      background: #ffffff;
      color: #06111f;
      font-weight: 900;
      transition: transform 180ms ease;
    }

    .skip-link:focus { transform: translateY(0); }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .page-shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; }

    .site-header {
      position: sticky;
      top: 0;
      z-index: 20;
      border-bottom: 1px solid var(--line);
      background: rgba(6, 17, 31, 0.82);
      backdrop-filter: blur(22px);
    }

    .nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      min-height: 76px;
    }

    .brand { display: inline-flex; align-items: center; gap: 12px; font-weight: 800; letter-spacing: -0.03em; }

    .brand-mark {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--green), var(--blue));
      color: #06111f;
      box-shadow: 0 14px 32px rgba(156, 255, 0, 0.2);
      text-transform: uppercase;
    }

    .nav-links { display: flex; gap: 22px; color: var(--muted); font-size: 0.95rem; }
    .nav-links a:hover { color: var(--text); }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 0 18px;
      border-radius: 999px;
      border: 1px solid transparent;
      font-weight: 800;
      letter-spacing: -0.01em;
    }

    .button.primary { background: var(--green); color: #06111f; box-shadow: 0 14px 34px rgba(156, 255, 0, 0.22); }
    .button.ghost { border-color: var(--line); color: var(--text); background: rgba(255, 255, 255, 0.04); }
    .button.primary:hover { background: #d6ff7a; }
    .button.ghost:hover { background: rgba(255, 255, 255, 0.09); }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.75fr);
      gap: 28px;
      align-items: stretch;
      padding: 82px 0 46px;
    }

    .eyebrow {
      margin: 0 0 16px;
      color: var(--green);
      font-size: 0.78rem;
      font-weight: 900;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    h1, h2, h3, p { margin-top: 0; }

    h1 {
      max-width: 840px;
      margin-bottom: 20px;
      font-size: clamp(3rem, 6.6vw, 5.7rem);
      line-height: 0.94;
      letter-spacing: -0.07em;
      text-wrap: balance;
    }

    .lead { max-width: 690px; margin-bottom: 28px; color: #d7e0f0; font-size: clamp(1.08rem, 2.4vw, 1.35rem); }
    .hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 26px; }

    .guide-list {
      display: grid;
      gap: 10px;
      max-width: 680px;
      margin: 0 0 26px;
      padding: 0;
      list-style: none;
      color: #dce6f4;
    }

    .guide-list li {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.045);
    }

    .guide-list strong {
      display: inline-grid;
      flex: 0 0 auto;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: var(--green);
      color: #06111f;
      font-size: 0.86rem;
    }

    .hero-meta { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); }
    .pill { display: inline-flex; gap: 8px; align-items: center; padding: 9px 12px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255, 255, 255, 0.05); }
    .pill strong { color: var(--text); }

    .hero-card {
      position: relative;
      overflow: hidden;
      min-height: 530px;
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: calc(var(--radius) + 8px);
      background:
        linear-gradient(180deg, rgba(128, 215, 255, 0.15), transparent 42%),
        linear-gradient(135deg, rgba(255, 255, 255, 0.11), rgba(255, 255, 255, 0.03));
      box-shadow: var(--shadow);
    }

    .hero-card::before {
      content: "";
      position: absolute;
      inset: auto -20% -34% 18%;
      height: 280px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(199, 255, 79, 0.35), transparent 62%);
      filter: blur(6px);
    }

    .forecast-panel { position: relative; z-index: 1; display: grid; gap: 18px; }
    .panel-label { color: var(--muted); font-size: 0.86rem; text-transform: uppercase; letter-spacing: 0.12em; }
    .hero-number { display: block; margin: 8px 0 2px; font-size: clamp(2.6rem, 8vw, 5.1rem); line-height: 0.92; letter-spacing: -0.075em; }
    .panel-copy { color: #d5deec; }

    .meter { height: 12px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, 0.08); }
    .meter span { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--green), var(--blue)); transition: width 700ms ease; }

    .mini-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .mini-card { padding: 18px; border: 1px solid var(--line); border-radius: 22px; background: rgba(6, 17, 31, 0.72); }
    .mini-card span { display: block; color: var(--muted); font-size: 0.85rem; }
    .mini-card strong { display: block; margin-top: 8px; font-size: 1.2rem; letter-spacing: -0.03em; }

    .trust-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: center;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 24px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--muted);
    }

    .trust-strip span { padding: 9px 14px; border-radius: 999px; background: rgba(255, 255, 255, 0.05); color: #dfe8f7; }

    .decision-note {
      margin-bottom: 18px;
      padding: 18px 20px;
      border: 1px solid rgba(199, 255, 79, 0.35);
      border-radius: 22px;
      background: rgba(199, 255, 79, 0.08);
      color: #efffce;
      font-weight: 800;
    }

    section { padding: 52px 0; }
    .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
    .section-heading h2 { margin-bottom: 0; max-width: 760px; font-size: clamp(2rem, 5vw, 4.3rem); line-height: 0.95; letter-spacing: -0.065em; }
    .section-heading p { max-width: 440px; margin-bottom: 0; color: var(--muted); }

    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .metric-card, .window-card, .share-card, .table-card, .caveat-card {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: 0 20px 55px rgba(0, 0, 0, 0.18);
    }

    .metric-card { min-height: 190px; padding: 24px; }
    .metric-card .label { color: var(--muted); font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.75rem; }
    .metric-card .value { display: block; margin: 18px 0 12px; font-size: clamp(1.9rem, 4vw, 3.1rem); line-height: 1; letter-spacing: -0.06em; }
    .metric-card .detail { color: #c2cee0; }
    .metric-card.accent { background: linear-gradient(135deg, rgba(199, 255, 79, 0.18), rgba(128, 215, 255, 0.08)), var(--surface); }

    .window-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
    .window-card { padding: 22px; }
    .window-card h3 { margin-bottom: 14px; font-size: 1.25rem; letter-spacing: -0.03em; }
    .window-card dl { display: grid; gap: 12px; margin: 0; }
    .window-card div { display: flex; justify-content: space-between; gap: 14px; border-top: 1px solid var(--line); padding-top: 10px; }
    .window-card dt { color: var(--muted); }
    .window-card dd { margin: 0; text-align: right; font-weight: 800; }

    .split-grid { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 18px; align-items: start; }
    .share-card { padding: 22px; }
    .share-list { display: grid; gap: 14px; }
    .share-row-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 9px; }
    .share-row-top span { color: var(--muted); }
    .share-meter { position: relative; height: 12px; overflow: hidden; border-radius: 999px; background: rgba(255, 255, 255, 0.08); }
    .share-meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--green), var(--blue)); }
    .share-caption { margin-top: 8px; color: var(--muted); font-size: 0.9rem; }

    .table-card { overflow: hidden; }
    .table-card h3 { margin: 0; padding: 22px 22px 0; }
    .table-wrap { overflow-x: auto; }
    caption { padding: 0 22px 12px; color: var(--muted); text-align: left; }
    table { width: 100%; border-collapse: collapse; min-width: 720px; }
    th, td { padding: 15px 18px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 0.75rem; letter-spacing: 0.12em; text-transform: uppercase; }
    td { color: #e5edf8; }
    td:last-child, th:last-child { text-align: right; }
    tbody tr:hover { background: rgba(255, 255, 255, 0.04); }

    .latest-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .latest-card { padding: 18px; border: 1px solid var(--line); border-radius: 22px; background: rgba(255, 255, 255, 0.05); }
    .latest-card span { display: block; color: var(--muted); }
    .latest-card strong { display: block; margin-top: 8px; font-size: 1.25rem; letter-spacing: -0.03em; }

    .caveat-card { padding: 28px; background: linear-gradient(135deg, rgba(255, 143, 212, 0.12), rgba(128, 215, 255, 0.07)), var(--surface); }
    .caveat-card ul { display: grid; gap: 10px; margin: 0; padding-left: 20px; color: #d8e2f0; }

    .site-footer { padding: 36px 0 54px; color: var(--muted); }
    .site-footer .page-shell { display: flex; justify-content: space-between; gap: 18px; border-top: 1px solid var(--line); padding-top: 24px; }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }

    @media (max-width: 980px) {
      .hero, .split-grid { grid-template-columns: 1fr; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .window-grid, .latest-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .nav-links { display: none; }
    }

    @media (max-width: 640px) {
      .page-shell { width: min(100% - 22px, 1180px); }
      .nav { min-height: 68px; }
      .button.ghost { display: none; }
      .hero { padding-top: 48px; }
      .hero-card { min-height: auto; }
      .mini-grid, .metric-grid, .window-grid, .latest-grid { grid-template-columns: 1fr; }
      .section-heading { display: block; }
      h1 { font-size: clamp(2.85rem, 14vw, 4.5rem); }
      table { min-width: 640px; }
      .site-footer .page-shell { display: block; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to report content</a>
  <header class="site-header">
    <div class="page-shell nav">
      <a class="brand" href="#main" aria-label="Tinyfinance home"><span class="brand-mark">tf</span><span>Tinyfinance</span></a>
      <nav class="nav-links" aria-label="Report sections">
        <a href="#summary">Overview</a>
        <a href="#moves">Actions</a>
        <a href="#shares">Share plan</a>
        <a href="#windows">Evidence</a>
      </nav>
      <a class="button ghost" href="recent_rebalancer_payload.json">Payload JSON</a>
    </div>
  </header>

  <main id="main" class="page-shell" tabindex="-1">
    <section class="hero" aria-labelledby="hero-title">
      <div>
        <p class="eyebrow">Recent-market FinOps rebalancer</p>
        <h1 id="hero-title">Tomorrow's savings, simplified.</h1>
        <p class="lead">This report answers three questions first: current forecast cost, optimized forecast cost, and the savings worth reviewing. Values are ratio-weighted units from the AIEVEN price catalog.</p>
        <ol class="guide-list" aria-label="How to read this report">
          <li><strong>1</strong><span>Start with the savings number and cost change.</span></li>
          <li><strong>2</strong><span>Review the highest-impact moves before changing cloud share.</span></li>
          <li><strong>3</strong><span>Use the recent-window evidence to challenge the assumption model.</span></li>
        </ol>
        <div class="hero-actions">
          <a class="button primary" href="#moves">Review actions</a>
          <a class="button ghost" href="recommended_cloud_share_changes.csv">Download share plan</a>
        </div>
        <div class="hero-meta" aria-label="Run metadata">
          <span class="pill">Forecast <strong id="forecast-date">...</strong></span>
          <span class="pill">Observed through <strong id="latest-date">...</strong></span>
          <span class="pill">Window <strong>${lookbackDays} days</strong></span>
          <span class="pill">Target margin <strong>${targetMargin}</strong></span>
          <span class="pill">Market band <strong>+/-${marketFluctuation}</strong></span>
        </div>
      </div>

      <aside class="hero-card" aria-label="Forecast savings summary">
        <div class="forecast-panel">
          <div>
            <span class="panel-label">Forecast savings</span>
            <strong class="hero-number" id="hero-savings">...</strong>
            <p class="panel-copy">Modeled savings if eligible units move to the lowest equivalent p50-ratio cloud in this scenario.</p>
          </div>
          <div>
            <div class="meter" aria-hidden="true"><span id="savings-meter"></span></div>
            <p class="share-caption"><span id="savings-rate">...</span> of base forecast cost.</p>
          </div>
          <div class="mini-grid">
            <div class="mini-card"><span>Base forecast</span><strong id="hero-cost">...</strong></div>
            <div class="mini-card"><span>Optimized cost</span><strong id="hero-optimized">...</strong></div>
            <div class="mini-card"><span>Margin after changes</span><strong id="hero-margin">...</strong></div>
            <div class="mini-card"><span>Generated</span><strong>${generatedAt}</strong></div>
          </div>
        </div>
      </aside>
    </section>

    <div class="trust-strip" aria-label="Data pipeline badges">
      <span>DuckDB SQL</span>
      <span>Local Parquet</span>
      <span>Browser-rendered summary</span>
      <span>WCAG-aware layout</span>
    </div>

    <section id="summary" aria-labelledby="summary-title">
      <div class="section-heading">
        <h2 id="summary-title">The short answer.</h2>
        <p>Three cards, one decision note. Detail stays available without competing with the recommendation.</p>
      </div>
      <p class="decision-note" id="decision-note">Loading recommendation...</p>
      <div class="metric-grid" id="summary-cards"></div>
    </section>

    <section id="moves" aria-labelledby="moves-title">
      <div class="section-heading">
        <h2 id="moves-title">Recommended actions.</h2>
        <p>The table is capped to the highest-impact cloud moves so it is easier to scan. The full forecast remains in CSV and JSON.</p>
      </div>
      <div class="table-card">
        <h3>Highest impact moves</h3>
        <div class="table-wrap">
          <table>
            <caption>Top savings opportunities by price class and cloud route.</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Price class</th><th scope="col">Route</th><th scope="col">Forecast units</th><th scope="col">Current cost</th><th scope="col">Optimized cost</th><th scope="col">Savings</th></tr></thead>
            <tbody id="moves-table"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="shares" aria-labelledby="shares-title">
      <div class="section-heading">
        <h2 id="shares-title">Cloud-share plan.</h2>
        <p>Share uses current ratio-weighted cost value because the raw units mix hours, storage months, GB, GiB-hours, and IP-hours.</p>
      </div>
      <div class="split-grid">
        <div class="share-card">
          <h3>Target workload share</h3>
          <div class="share-list" id="share-bars"></div>
        </div>
        <div class="table-card">
          <h3>Recommended cloud share changes</h3>
          <div class="table-wrap">
            <table>
              <caption>Current and target workload-value share by anonymized cloud.</caption>
              <thead><tr><th scope="col">Cloud</th><th scope="col">Current share</th><th scope="col">Target share</th><th scope="col">Delta</th><th scope="col">Optimized cost share</th></tr></thead>
              <tbody id="share-table"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section id="windows" aria-labelledby="windows-title">
      <div class="section-heading">
        <h2 id="windows-title">Evidence windows.</h2>
        <p>The model uses only recent windows: last recency window, previous comparable window, latest full month, and month-to-date.</p>
      </div>
      <div class="window-grid" id="window-cards"></div>
    </section>

    <section aria-labelledby="latest-title">
      <div class="section-heading">
        <h2 id="latest-title">Latest day by cloud.</h2>
        <p>A quick operational pulse for the most recent date present in the local Parquet input.</p>
      </div>
      <div class="latest-grid" id="latest-day"></div>
    </section>

    <section aria-labelledby="caveats-title">
      <div class="caveat-card">
        <p class="eyebrow">Model caveats</p>
        <h2 id="caveats-title">Assumption model, not an invoice.</h2>
        <ul>
          <li id="warning-text">${escapeHtml(output.warning)}</li>
          <li>p50 ratios are from <code>cross_cloud_list_prices.parquet</code>; outputs are ratio-weighted units, not EUR.</li>
          <li>Cloud labels are anonymized IDs from the sanitized input, not public provider names.</li>
          <li>The model ignores migration cost, latency, compliance constraints, reservations, customer cloud preferences, and support obligations.</li>
        </ul>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="page-shell">
      <span>Tinyfinance recent-market rebalancer</span>
      <span>Accessibility pass: clear headings, keyboard focus, contrast, captions, and reduced motion.</span>
    </div>
  </footer>

  <script type="application/json" id="rebalancer-data">${dataJson}</script>
  <script>
    (function () {
      var dataElement = document.getElementById("rebalancer-data");
      if (!dataElement) return;

      var data = JSON.parse(dataElement.textContent || "{}");
      var summary = data.forecastSummary || {};
      var scope = data.scope || {};
      var ratioWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
      var ratioPrecise = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      var numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
      var pctFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

      function numeric(value) {
        var n = Number(value);
        return Number.isFinite(n) ? n : 0;
      }

      function ratioUnits(value) {
        var n = numeric(value);
        return (Math.abs(n) < 100 ? ratioPrecise : ratioWhole).format(n) + " ratio units";
      }

      function number(value) {
        return numberFormat.format(numeric(value));
      }

      function pct(value) {
        return pctFormat.format(numeric(value)) + "%";
      }

      function signedPctPoints(value) {
        var n = numeric(value);
        return (n >= 0 ? "+" : "") + pct(n);
      }

      function setText(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
      }

      function create(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
      }

      function appendMetric(container, label, value, detail, accent) {
        var card = create("article", "metric-card" + (accent ? " accent" : ""));
        card.appendChild(create("span", "label", label));
        card.appendChild(create("strong", "value", value));
        card.appendChild(create("p", "detail", detail));
        container.appendChild(card);
      }

      function appendTableRow(tbody, values) {
        var tr = document.createElement("tr");
        values.forEach(function (value) {
          var td = document.createElement("td");
          td.textContent = value;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }

      function windowTitle(name) {
        var lookback = numeric(scope.lookbackDays) || ${Number(args.lookbackDays)};
        var titles = {
          last_30_days: "Last " + lookback + " days",
          previous_30_days: "Previous " + lookback + " days",
          latest_full_month: "Latest full month",
          month_to_date: "Month to date"
        };
        return titles[name] || String(name || "Window").replace(/_/g, " ");
      }

      setText("forecast-date", scope.forecastDate || "tomorrow");
      setText("latest-date", scope.maxObservedDate || "unknown");
      setText("hero-savings", ratioUnits(summary.forecastSavingsRatioUnits));
      setText("hero-cost", ratioUnits(summary.forecastCurrentCostRatioUnits));
      setText("hero-optimized", ratioUnits(summary.forecastOptimizedCostRatioUnits));
      setText("hero-margin", pct(summary.optimizedMarginPctIfRevenueUnchanged));

      var savingsRate = numeric(summary.forecastCurrentCostRatioUnits) > 0
        ? (numeric(summary.forecastSavingsRatioUnits) / numeric(summary.forecastCurrentCostRatioUnits)) * 100
        : 0;
      var meter = document.getElementById("savings-meter");
      if (meter) meter.style.width = Math.min(100, Math.max(0, savingsRate)).toFixed(2) + "%";
      setText("savings-rate", pct(savingsRate));
      setText("decision-note", "Review " + ratioUnits(summary.forecastSavingsRatioUnits) + " of modeled savings before changing cloud share. This is an assumption model, so validate the top actions against latency, compliance, capacity, and customer preference.");

      var summaryCards = document.getElementById("summary-cards");
      if (summaryCards) {
        appendMetric(summaryCards, "Current forecast", ratioUnits(summary.forecastCurrentCostRatioUnits), "Tomorrow's modeled cost before recommended changes.", false);
        appendMetric(summaryCards, "After recommendation", ratioUnits(summary.forecastOptimizedCostRatioUnits), "Modeled cost after eligible reroutes.", false);
        appendMetric(summaryCards, "Savings to review", ratioUnits(summary.forecastSavingsRatioUnits), pct(savingsRate) + " of the base forecast cost.", true);
      }

      var windowCards = document.getElementById("window-cards");
      (data.windowSummary || []).forEach(function (row) {
        if (!windowCards) return;
        var card = create("article", "window-card");
        card.appendChild(create("h3", "", windowTitle(row.window_name)));
        var dl = document.createElement("dl");
        [
          ["Dates", String(row.start_date || "") + " to " + String(row.end_date || "")],
          ["Modeled cost", ratioUnits(row.modeled_cost_ratio_units)],
          ["Optimized", ratioUnits(row.optimized_cost_ratio_units)],
          ["Savings", ratioUnits(row.theoretical_savings_ratio_units)],
          ["Catalog rows", pct(row.catalog_price_row_pct)]
        ].forEach(function (pair) {
          var line = document.createElement("div");
          line.appendChild(create("dt", "", pair[0]));
          line.appendChild(create("dd", "", pair[1]));
          dl.appendChild(line);
        });
        card.appendChild(dl);
        windowCards.appendChild(card);
      });

      var shareBars = document.getElementById("share-bars");
      var shareTable = document.getElementById("share-table");
      (data.recommendedShareChanges || []).forEach(function (row) {
        if (shareBars) {
          var item = create("article", "");
          var top = create("div", "share-row-top");
          top.appendChild(create("strong", "", String(row.cloud || "Unknown")));
          top.appendChild(create("span", "", signedPctPoints(row.workloadShareDeltaPctPoints) + " pts"));
          item.appendChild(top);
          var bar = create("div", "share-meter");
          bar.setAttribute("role", "img");
          bar.setAttribute("aria-label", String(row.cloud || "Unknown") + " target share " + pct(row.targetWorkloadSharePct) + ", change " + signedPctPoints(row.workloadShareDeltaPctPoints) + " points");
          var fill = document.createElement("span");
          fill.style.width = Math.min(100, Math.max(0, numeric(row.targetWorkloadSharePct))).toFixed(2) + "%";
          bar.appendChild(fill);
          item.appendChild(bar);
          item.appendChild(create("p", "share-caption", "Current " + pct(row.currentWorkloadSharePct) + " -> target " + pct(row.targetWorkloadSharePct)));
          shareBars.appendChild(item);
        }
        if (shareTable) {
          appendTableRow(shareTable, [
            String(row.cloud || "Unknown"),
            pct(row.currentWorkloadSharePct),
            pct(row.targetWorkloadSharePct),
            signedPctPoints(row.workloadShareDeltaPctPoints) + " pts",
            pct(row.optimizedCostSharePct)
          ]);
        }
      });

      var movesTable = document.getElementById("moves-table");
      (data.topMoves || []).slice(0, 8).forEach(function (row, index) {
        if (!movesTable) return;
        appendTableRow(movesTable, [
          String(index + 1),
          String(row.priceClass || ""),
          String(row.currentCloud || "") + " -> " + String(row.targetCloud || ""),
          number(row.forecastUnits),
          ratioUnits(row.currentCostRatioUnits),
          ratioUnits(row.optimizedCostRatioUnits),
          ratioUnits(row.savingsRatioUnits)
        ]);
      });

      var latest = document.getElementById("latest-day");
      (data.latestDay || []).slice(0, 4).forEach(function (row) {
        if (!latest) return;
        var card = create("article", "latest-card");
        card.appendChild(create("span", "", String(row.cloud || "Unknown cloud")));
        card.appendChild(create("strong", "", ratioUnits(row.modeled_cost_ratio_units)));
        card.appendChild(create("p", "share-caption", "Optimized " + ratioUnits(row.optimized_cost_ratio_units) + ", savings " + ratioUnits(row.theoretical_savings_ratio_units)));
        latest.appendChild(card);
      });
    })();
  </script>
</body>
</html>`;
}

function safeJsonForScript(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

async function writeCsv(filePath: string, rows: Record<string, unknown>[]) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const content = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n";
  await writeFile(filePath, content, "utf8");
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

function sqlValue(value: unknown): string {
  if (typeof value === "string") return `'${sqlString(value)}'`;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (value === null || value === undefined) return "NULL";
  return `'${sqlString(String(value))}'`;
}

function sqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function normalizedUnitSql(column: string): string {
  return `CASE ${column}
    WHEN 'gib' THEN 'gb'
    WHEN 'gib-hour' THEN 'hour'
    WHEN 'gib-month' THEN 'month'
    WHEN 'gb-month' THEN 'month'
    WHEN 'vcpu-hours' THEN 'hour'
    WHEN 'lcu-hrs' THEN 'hour'
    WHEN '1/hour' THEN 'hour'
    ELSE ${column}
  END`;
}

function numberValue(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function pct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatRatioUnits(value: unknown): string {
  return `${formatNumber(numberValue(value))} ratio units`;
}

function formatNumber(value: unknown): string {
  return numberValue(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatPct(value: unknown): string {
  return `${numberValue(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

function signed(value: number): string {
  return value >= 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
