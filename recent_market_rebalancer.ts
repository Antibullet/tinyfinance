import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const duckdb = require("duckdb");

const USD_TO_EUR = 0.92;
const HOURS_PER_MONTH = 730;

type CloudMap = {
  cloud: string;
  provider: string;
  confidence: "high" | "medium-high" | "low";
  evidence: string;
};

type ProviderPrice = {
  provider: string;
  priceClass: string;
  eurPerUnit: number;
  allowReroute: boolean;
  sourceNote: string;
};

type ForecastRow = {
  currentProvider: string;
  targetProvider: string;
  priceClass: string;
  forecastUnits: number;
  currentEurPerUnit: number;
  targetEurPerUnit: number;
  currentCostEur: number;
  optimizedCostEur: number;
  savingsEur: number;
};

type ShareRow = {
  provider: string;
  currentWorkloadValueEur: number;
  currentWorkloadSharePct: number;
  targetWorkloadValueEur: number;
  targetWorkloadSharePct: number;
  workloadShareDeltaPctPoints: number;
  currentCostEur: number;
  optimizedCostEur: number;
  optimizedCostSharePct: number;
};

type ForecastSummary = {
  forecastCurrentCostEur: number;
  forecastLowMarketCostEur: number;
  forecastHighMarketCostEur: number;
  forecastOptimizedCostEur: number;
  forecastSavingsEur: number;
  requiredRevenueFor10PctMarginEur: number;
  profitAt10PctMarginEur: number;
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

const cloudMap: CloudMap[] = [
  {
    cloud: "cloud_b",
    provider: "Google Cloud",
    confidence: "medium-high",
    evidence: "Split CPU/RAM billing, commitment-discount style rows, persistent disk and inter-zone transfer terms.",
  },
  {
    cloud: "cloud_c",
    provider: "Microsoft Azure",
    confidence: "high",
    evidence: "Premium SSD v2, Managed Disks, Dv2/Dasv5/Dsv5/Dpsv5 VM series, Virtual Network.",
  },
  {
    cloud: "cloud_d",
    provider: "AWS",
    confidence: "high",
    evidence: "EBS Volume, LCU hours, public IPv4, and AWS-like network egress line items.",
  },
  {
    cloud: "cloud_a",
    provider: "UpCloud",
    confidence: "low",
    evidence: "Highly scrubbed unknown-unit rows. Treated as a small independent-cloud footprint for this scenario only.",
  },
];

const eur = (usd: number) => usd * USD_TO_EUR;

const providerPrices: ProviderPrice[] = [
  price("Google Cloud", "compute_general_hour", eur(0.096), true, "Representative N2/E2 2-vCPU VM-hour assumption."),
  price("Google Cloud", "compute_cpu_hour", eur(0.0475), true, "Approximate GCP vCPU-hour proxy."),
  price("Google Cloud", "memory_gib_hour", eur(0.0064), true, "Approximate GCP RAM GiB-hour proxy."),
  price("Google Cloud", "compute_memory_hour", eur(0.126), true, "Representative memory-leaning VM-hour assumption."),
  price("Google Cloud", "ssd_gb_month", eur(0.17), true, "Approximate persistent SSD GB-month assumption."),
  price("Google Cloud", "hdd_gb_month", eur(0.04), true, "Approximate standard disk GB-month assumption."),
  price("Google Cloud", "egress_internet_gb", eur(0.12), true, "Representative internet egress GB assumption."),
  price("Google Cloud", "egress_intra_gb", eur(0.01), true, "Representative same/near-region transfer GB assumption."),
  price("Google Cloud", "egress_cross_gb", eur(0.02), true, "Representative inter-region transfer GB assumption."),
  price("Google Cloud", "ipv4_hour", eur(0.004), true, "Public IPv4 hourly assumption."),
  price("Google Cloud", "lb_hour", eur(0.025), true, "Representative load-balancer hour assumption."),
  price("Google Cloud", "lcu_hour", eur(0.008), true, "Generic load-balancer capacity unit assumption."),
  price("Google Cloud", "other_network_gb", eur(0.01), true, "Fallback private-network GB assumption."),

  price("Microsoft Azure", "compute_general_hour", eur(0.096), true, "Representative D-series 2-vCPU Linux VM-hour assumption."),
  price("Microsoft Azure", "compute_cpu_hour", eur(0.049), true, "Derived D/F-series vCPU-hour proxy."),
  price("Microsoft Azure", "memory_gib_hour", eur(0.0068), true, "Derived RAM GiB-hour proxy."),
  price("Microsoft Azure", "compute_memory_hour", eur(0.13), true, "Representative memory-leaning VM-hour assumption."),
  price("Microsoft Azure", "ssd_gb_month", eur(0.15), true, "Representative Premium SSD/Premium SSD v2 GB-month assumption."),
  price("Microsoft Azure", "hdd_gb_month", eur(0.045), true, "Representative standard HDD/managed disk GB-month assumption."),
  price("Microsoft Azure", "egress_internet_gb", eur(0.087), true, "Representative Azure internet egress GB assumption."),
  price("Microsoft Azure", "egress_intra_gb", eur(0.01), true, "Representative intra-zone/intra-region transfer GB assumption."),
  price("Microsoft Azure", "egress_cross_gb", eur(0.02), true, "Representative inter-region transfer GB assumption."),
  price("Microsoft Azure", "ipv4_hour", eur(0.005), true, "Public IPv4 hourly assumption."),
  price("Microsoft Azure", "lb_hour", eur(0.025), true, "Representative load-balancer hour assumption."),
  price("Microsoft Azure", "lcu_hour", eur(0.008), true, "Generic load-balancer capacity unit assumption."),
  price("Microsoft Azure", "other_network_gb", eur(0.01), true, "Fallback private-network GB assumption."),

  price("AWS", "compute_general_hour", eur(0.1008), true, "Representative m7i.large Linux on-demand VM-hour assumption."),
  price("AWS", "compute_cpu_hour", eur(0.085), true, "Representative c7i.large-ish compute-optimized VM-hour assumption."),
  price("AWS", "memory_gib_hour", eur(0.0068), true, "AWS normally prices instances; this is a RAM GiB-hour proxy."),
  price("AWS", "compute_memory_hour", eur(0.126), true, "Representative memory-leaning VM-hour assumption."),
  price("AWS", "ssd_gb_month", eur(0.08), true, "EBS gp3-style GB-month assumption."),
  price("AWS", "hdd_gb_month", eur(0.045), true, "EBS HDD-style GB-month assumption."),
  price("AWS", "egress_internet_gb", eur(0.09), true, "Representative first-tier internet egress GB assumption."),
  price("AWS", "egress_intra_gb", eur(0.01), true, "Representative same-region/AZ transfer GB assumption."),
  price("AWS", "egress_cross_gb", eur(0.02), true, "Representative inter-region transfer GB assumption."),
  price("AWS", "ipv4_hour", eur(0.005), true, "AWS public IPv4 hourly charge assumption."),
  price("AWS", "lb_hour", eur(0.0225), true, "Application/NLB hourly assumption."),
  price("AWS", "lcu_hour", eur(0.008), true, "Load balancer capacity unit assumption."),
  price("AWS", "other_network_gb", eur(0.01), true, "Fallback private-network GB assumption."),

  price("UpCloud", "compute_general_hour", 24 / 672, true, "Cloud Native 2-vCPU/8GB at EUR 24/month over 28-day cap."),
  price("UpCloud", "compute_cpu_hour", 15 / 672, true, "Cloud Native 2-vCPU/4GB at EUR 15/month over 28-day cap."),
  price("UpCloud", "memory_gib_hour", (24 / 672) / 8, true, "Derived from Cloud Native 2-vCPU/8GB plan."),
  price("UpCloud", "compute_memory_hour", 34 / 672, true, "Cloud Native 2-vCPU/16GB at EUR 34/month over 28-day cap."),
  price("UpCloud", "ssd_gb_month", 0.22, true, "MaxIOPS block storage EUR 0.22/GB/month."),
  price("UpCloud", "hdd_gb_month", 0.085, true, "Standard block storage EUR 0.085/GB/month."),
  price("UpCloud", "egress_internet_gb", 0, true, "Advertised zero-cost transfer; fair transfer policy applies."),
  price("UpCloud", "egress_intra_gb", 0, true, "Assumed included private/intra transfer."),
  price("UpCloud", "egress_cross_gb", 0, true, "Assumed included transfer; fair transfer policy applies."),
  price("UpCloud", "ipv4_hour", 3.47 / 672, true, "Additional public IPv4 EUR 3.47/month over 28-day cap."),
  price("UpCloud", "lb_hour", 0.02, true, "Generic load-balancer assumption."),
  price("UpCloud", "lcu_hour", 0.008, true, "Generic capacity-unit assumption."),
  price("UpCloud", "other_network_gb", 0, true, "Assumed included private transfer."),

  price("Vultr", "compute_general_hour", eur(0.060), true, "VX1 2-vCPU/8GB at USD 0.060/hour."),
  price("Vultr", "compute_cpu_hour", eur(0.060), true, "VX1 proxy; no separate vCPU billing in this model."),
  price("Vultr", "memory_gib_hour", eur(0.080) / 16, true, "Memory-optimized 2-vCPU/16GB divided by RAM."),
  price("Vultr", "compute_memory_hour", eur(0.080), true, "Memory-optimized 2-vCPU/16GB at USD 0.080/hour."),
  price("Vultr", "ssd_gb_month", eur(0.10), true, "Block storage rough assumption."),
  price("Vultr", "hdd_gb_month", eur(0.05), true, "Lower-performance storage rough assumption."),
  price("Vultr", "egress_internet_gb", eur(0.01), true, "Overage/included-bandwidth proxy."),
  price("Vultr", "egress_intra_gb", 0, true, "Assumed private transfer included."),
  price("Vultr", "egress_cross_gb", eur(0.01), true, "Cross-region transfer proxy."),
  price("Vultr", "ipv4_hour", eur(2 / 730), true, "Public IPv4 rough monthly proxy."),
  price("Vultr", "lb_hour", eur(0.014), true, "Load balancer rough hourly proxy."),
  price("Vultr", "lcu_hour", eur(0.006), true, "Generic capacity-unit assumption."),
  price("Vultr", "other_network_gb", 0, true, "Assumed private transfer included."),

  price("Render", "compute_general_hour", eur(85 / 730), false, "Pro service 2 CPU/4GB at USD 85/month; PaaS, not equivalent IaaS."),
  price("Render", "compute_cpu_hour", eur(85 / 730), false, "PaaS service proxy; excluded from reroute optimization."),
  price("Render", "memory_gib_hour", eur((85 / 730) / 4), false, "Derived from Pro service 4GB RAM; excluded from reroute optimization."),
  price("Render", "compute_memory_hour", eur(100 / 730), false, "Render managed Postgres/service proxy; excluded from reroute optimization."),
  price("Render", "ssd_gb_month", eur(0.25), false, "Persistent disks USD 0.25/GB/month."),
  price("Render", "hdd_gb_month", eur(0.25), false, "Persistent disks USD 0.25/GB/month."),
  price("Render", "egress_internet_gb", eur(0.10), false, "Generic bandwidth overage proxy; PaaS not equivalent."),
  price("Render", "egress_intra_gb", 0, false, "No direct IaaS equivalent."),
  price("Render", "egress_cross_gb", eur(0.10), false, "Generic bandwidth proxy; PaaS not equivalent."),
  price("Render", "ipv4_hour", 0, false, "Feature-dependent; no direct IaaS equivalent."),
  price("Render", "lb_hour", 0, false, "Platform abstraction; no direct IaaS equivalent."),
  price("Render", "lcu_hour", 0, false, "No LCU equivalent."),
  price("Render", "other_network_gb", 0, false, "No direct equivalent."),
];

function price(provider: string, priceClass: string, eurPerUnit: number, allowReroute: boolean, sourceNote: string): ProviderPrice {
  return { provider, priceClass, eurPerUnit, allowReroute, sourceNote };
}

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
  const db = new DuckDB();
  await setupTables(db);
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
    .filter((row) => row.savingsEur > 0.01)
    .sort((a, b) => b.savingsEur - a.savingsEur)
    .slice(0, 30);

  const providerPricesForTomorrow = providerPrices.map((row) => ({
    provider: row.provider,
    priceClass: row.priceClass,
    baseEurPerUnit: row.eurPerUnit,
    lowEurPerUnit: row.eurPerUnit * (1 - args.marketFluctuation),
    highEurPerUnit: row.eurPerUnit * (1 + args.marketFluctuation),
    allowReroute: row.allowReroute,
    sourceNote: row.sourceNote,
  }));

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
    warning: "This is an assumption model. The Parquet data has sanitized/noised amounts and no real Aiven revenue.",
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
  await writeCsv(path.join(args.outDir, "latest_day_by_provider.csv"), latestDay);
  await writeCsv(path.join(args.outDir, "tomorrow_forecast_by_price_class.csv"), forecastRows);
  await writeCsv(path.join(args.outDir, "recommended_provider_share_changes.csv"), shareRows);
  await writeCsv(path.join(args.outDir, "top_tomorrow_moves.csv"), topMoves);
  await writeCsv(path.join(args.outDir, "tomorrow_unit_price_assumptions.csv"), providerPricesForTomorrow);
  await writeCsv(path.join(args.outDir, "cloud_mapping_assumptions_ts.csv"), cloudMap);
  await writeFile(path.join(args.outDir, "recent_rebalancer_payload.json"), JSON.stringify(output, jsonReplacer, 2), "utf8");
  await writeFile(markdownReportPath, buildReport(output, args), "utf8");
  await writeFile(htmlReportPath, htmlReport, "utf8");
  await writeFile(htmlIndexPath, htmlReport, "utf8");

  console.log("Created recent-market TypeScript rebalancing report");
  console.log(`Output folder: ${args.outDir}`);
  console.log(`Markdown report: ${markdownReportPath}`);
  console.log(`HTML website: ${htmlReportPath}`);
  console.log(`Forecast date: ${tomorrow}`);
  console.log(`Forecast base cost EUR: ${formatMoney(summary.forecastCurrentCostEur)}`);
  console.log(`Forecast optimized cost EUR: ${formatMoney(summary.forecastOptimizedCostEur)}`);
  console.log(`Forecast savings EUR: ${formatMoney(summary.forecastSavingsEur)}`);
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

async function setupTables(db: DuckDB) {
  await db.run("CREATE TEMP TABLE cloud_map(cloud VARCHAR, provider VARCHAR, confidence VARCHAR, evidence VARCHAR)");
  await db.run(`INSERT INTO cloud_map VALUES ${cloudMap.map((row) => sqlTuple([row.cloud, row.provider, row.confidence, row.evidence])).join(",")}`);
  await db.run("CREATE TEMP TABLE provider_prices(provider VARCHAR, price_class VARCHAR, eur_per_unit DOUBLE, allow_reroute BOOLEAN, source_note VARCHAR)");
  await db.run(`INSERT INTO provider_prices VALUES ${providerPrices.map((row) => sqlTuple([row.provider, row.priceClass, row.eurPerUnit, row.allowReroute, row.sourceNote])).join(",")}`);
}

async function createCostedView(db: DuckDB, usagePath: string) {
  await db.run(`
    CREATE OR REPLACE TEMP VIEW costed AS
    WITH classified AS (
      SELECT u.*,
             cm.provider,
             cm.confidence AS provider_mapping_confidence,
             CASE
               WHEN sku_family = 'commitment-discount' THEN 'excluded_commitment_discount'
               WHEN sku_family = 'compute-cpu-optimized' AND unit = 'hour' THEN 'compute_cpu_hour'
               WHEN sku_family = 'compute-general' AND unit IN ('hour', 'unknown') THEN 'compute_general_hour'
               WHEN sku_family = 'compute-memory' AND unit = 'gib-hour' THEN 'memory_gib_hour'
               WHEN sku_family = 'compute-memory' AND unit = 'hour' THEN 'compute_memory_hour'
               WHEN sku_family = 'storage-block-ssd' AND unit = 'gib-hour' THEN 'ssd_gb_month'
               WHEN sku_family = 'storage-block-ssd' AND unit IN ('gib-month', 'gb-month') THEN 'ssd_gb_month'
               WHEN sku_family = 'storage-block-hdd' AND unit IN ('gib-month', 'gb-month', 'month', '10k') THEN 'hdd_gb_month'
               WHEN sku_family = 'egress-internet' AND unit IN ('gb', 'gib') THEN 'egress_internet_gb'
               WHEN sku_family = 'egress-internet' AND unit IN ('hour', '1/hour') THEN 'lb_hour'
               WHEN sku_family = 'egress-intra-region' AND unit IN ('gb', 'gib') THEN 'egress_intra_gb'
               WHEN sku_family = 'egress-cross-region' AND unit IN ('gb', 'gib') THEN 'egress_cross_gb'
               WHEN sku_family = 'network-public-ip' AND unit = 'hour' THEN 'ipv4_hour'
               WHEN sku_family = 'network-lb' AND unit = 'hour' THEN 'lb_hour'
               WHEN sku_family = 'network-lb' AND unit IN ('gb', 'gib') THEN 'other_network_gb'
               WHEN unit = 'lcu-hrs' THEN 'lcu_hour'
               WHEN sku_family = 'other' AND cost_category_group = 'Compute' AND unit IN ('hour', 'unknown', 'vcpu-hours') THEN 'compute_general_hour'
               WHEN sku_family = 'other' AND cost_category_group = 'Network' AND unit IN ('gb', 'gib') THEN 'other_network_gb'
               ELSE 'unpriced'
             END AS price_class,
             CASE
               WHEN sku_family = 'storage-block-ssd' AND unit = 'gib-hour' THEN amount / ${HOURS_PER_MONTH}
               ELSE amount
             END AS billable_units
      FROM read_parquet('${sqlString(usagePath)}') u
      LEFT JOIN cloud_map cm USING (cloud)
    ),
    cheapest AS (
      SELECT provider AS cheapest_provider, price_class, eur_per_unit AS cheapest_eur_per_unit
      FROM (
        SELECT *, row_number() OVER (PARTITION BY price_class ORDER BY eur_per_unit ASC, provider ASC) AS rn
        FROM provider_prices
        WHERE allow_reroute = TRUE
      )
      WHERE rn = 1
    )
    SELECT c.*,
           pp.eur_per_unit AS current_eur_per_unit,
           ch.cheapest_provider,
           ch.cheapest_eur_per_unit,
           CASE WHEN c.price_class IN ('excluded_commitment_discount', 'unpriced') THEN NULL ELSE c.billable_units * pp.eur_per_unit END AS current_cost_eur,
           CASE WHEN c.price_class IN ('excluded_commitment_discount', 'unpriced') THEN NULL ELSE c.billable_units * ch.cheapest_eur_per_unit END AS cheapest_cost_eur,
           CASE WHEN c.price_class IN ('excluded_commitment_discount', 'unpriced') THEN NULL ELSE greatest((c.billable_units * pp.eur_per_unit) - (c.billable_units * ch.cheapest_eur_per_unit), 0) END AS theoretical_savings_eur
    FROM classified c
    LEFT JOIN provider_prices pp ON c.provider = pp.provider AND c.price_class = pp.price_class
    LEFT JOIN cheapest ch ON c.price_class = ch.price_class
  `);
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
           count(c.line_id) FILTER (WHERE c.current_cost_eur IS NOT NULL) AS priced_rows,
           round(100.0 * count(c.line_id) FILTER (WHERE c.current_cost_eur IS NOT NULL) / nullif(count(c.line_id), 0), 2) AS priced_row_pct,
           round(coalesce(sum(c.current_cost_eur), 0), 2) AS modeled_cost_eur,
           round(coalesce(sum(c.current_cost_eur), 0) * (1 - ${args.marketFluctuation}), 2) AS low_market_cost_eur,
           round(coalesce(sum(c.current_cost_eur), 0) * (1 + ${args.marketFluctuation}), 2) AS high_market_cost_eur,
           round(coalesce(sum(c.theoretical_savings_eur), 0), 2) AS theoretical_savings_eur,
           round(coalesce(sum(c.current_cost_eur), 0) - coalesce(sum(c.theoretical_savings_eur), 0), 2) AS optimized_cost_eur,
           round(coalesce(sum(c.current_cost_eur), 0) / (1 - ${args.targetMargin}), 2) AS revenue_required_for_target_margin_eur,
           round((coalesce(sum(c.current_cost_eur), 0) / (1 - ${args.targetMargin})) - coalesce(sum(c.current_cost_eur), 0), 2) AS profit_at_target_margin_eur,
           round(100.0 * ((coalesce(sum(c.current_cost_eur), 0) / (1 - ${args.targetMargin})) - (coalesce(sum(c.current_cost_eur), 0) - coalesce(sum(c.theoretical_savings_eur), 0))) / nullif(coalesce(sum(c.current_cost_eur), 0) / (1 - ${args.targetMargin}), 0), 2) AS margin_after_savings_pct,
           round(coalesce(sum(CASE WHEN c.price_class = 'excluded_commitment_discount' THEN c.amount ELSE 0 END), 0), 2) AS excluded_commitment_raw_amount,
           round(coalesce(sum(CASE WHEN c.price_class = 'unpriced' THEN c.amount ELSE 0 END), 0), 2) AS unpriced_raw_amount
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
           c.provider,
           count(*) AS total_rows,
           count(*) FILTER (WHERE c.current_cost_eur IS NOT NULL) AS priced_rows,
           round(coalesce(sum(c.current_cost_eur), 0), 2) AS modeled_cost_eur,
           round(coalesce(sum(c.current_cost_eur), 0) * (1 - ${args.marketFluctuation}), 2) AS low_market_cost_eur,
           round(coalesce(sum(c.current_cost_eur), 0) * (1 + ${args.marketFluctuation}), 2) AS high_market_cost_eur,
           round(coalesce(sum(c.theoretical_savings_eur), 0), 2) AS theoretical_savings_eur,
           round(coalesce(sum(c.current_cost_eur), 0) - coalesce(sum(c.theoretical_savings_eur), 0), 2) AS optimized_cost_eur
    FROM costed c
    JOIN bounds b ON c.status_date::DATE = b.max_date
    GROUP BY 1,2
    ORDER BY modeled_cost_eur DESC
  `;
}

function dailyPriceClassSql(args: Args): string {
  return `
    WITH bounds AS (SELECT max(status_date)::DATE AS max_date FROM costed)
    SELECT CAST(c.status_date::DATE AS VARCHAR) AS status_date,
           c.provider AS current_provider,
           c.price_class,
           c.cheapest_provider,
           avg(c.current_eur_per_unit) AS current_eur_per_unit,
           avg(c.cheapest_eur_per_unit) AS cheapest_eur_per_unit,
           round(sum(c.billable_units), 8) AS billable_units,
           round(sum(c.current_cost_eur), 8) AS current_cost_eur,
           round(sum(c.theoretical_savings_eur), 8) AS theoretical_savings_eur
    FROM costed c
    JOIN bounds b ON c.status_date::DATE >= b.max_date - (${args.lookbackDays - 1} * INTERVAL 1 DAY)
    WHERE c.current_cost_eur IS NOT NULL
    GROUP BY 1,2,3,4
    ORDER BY 1,2,3
  `;
}

function buildForecastRows(rows: Record<string, unknown>[], lookbackDays: number, alpha: number): ForecastRow[] {
  const dates = [...new Set(rows.map((row) => String(row.status_date)))].sort();
  const keys = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = `${row.current_provider}|||${row.price_class}|||${row.cheapest_provider}`;
    const list = keys.get(key) ?? [];
    list.push(row);
    keys.set(key, list);
  }

  const result: ForecastRow[] = [];
  for (const [key, keyRows] of keys) {
    const [currentProvider, priceClass, cheapestProvider] = key.split("|||");
    const byDate = new Map(keyRows.map((row) => [String(row.status_date), row]));
    const currentUnitPrice = numberValue(keyRows.find((row) => row.current_eur_per_unit !== null)?.current_eur_per_unit);
    const cheapestUnitPrice = numberValue(keyRows.find((row) => row.cheapest_eur_per_unit !== null)?.cheapest_eur_per_unit);
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
    const targetProvider = currentUnitPrice > cheapestUnitPrice ? cheapestProvider : currentProvider;
    const targetUnitPrice = currentUnitPrice > cheapestUnitPrice ? cheapestUnitPrice : currentUnitPrice;
    const currentCost = ewmaUnits * currentUnitPrice;
    const optimizedCost = ewmaUnits * targetUnitPrice;
    result.push({
      currentProvider,
      targetProvider,
      priceClass,
      forecastUnits: ewmaUnits,
      currentEurPerUnit: currentUnitPrice,
      targetEurPerUnit: targetUnitPrice,
      currentCostEur: currentCost,
      optimizedCostEur: optimizedCost,
      savingsEur: Math.max(currentCost - optimizedCost, 0),
    });
  }
  return result.sort((a, b) => b.savingsEur - a.savingsEur);
}

function buildForecastSummary(rows: ForecastRow[], args: Args): ForecastSummary {
  const current = sum(rows.map((row) => row.currentCostEur));
  const optimized = sum(rows.map((row) => row.optimizedCostEur));
  const savings = current - optimized;
  const revenueRequired = current / (1 - args.targetMargin);
  const optimizedMargin = revenueRequired > 0 ? ((revenueRequired - optimized) / revenueRequired) * 100 : 0;
  return {
    forecastCurrentCostEur: round(current),
    forecastLowMarketCostEur: round(current * (1 - args.marketFluctuation)),
    forecastHighMarketCostEur: round(current * (1 + args.marketFluctuation)),
    forecastOptimizedCostEur: round(optimized),
    forecastSavingsEur: round(savings),
    requiredRevenueFor10PctMarginEur: round(revenueRequired),
    profitAt10PctMarginEur: round(revenueRequired - current),
    optimizedMarginPctIfRevenueUnchanged: round(optimizedMargin),
  };
}

function buildShareRows(rows: ForecastRow[]): ShareRow[] {
  const providers = new Set<string>();
  const currentValue = new Map<string, number>();
  const targetValue = new Map<string, number>();
  const currentCost = new Map<string, number>();
  const optimizedCost = new Map<string, number>();

  for (const row of rows) {
    providers.add(row.currentProvider);
    providers.add(row.targetProvider);
    currentValue.set(row.currentProvider, (currentValue.get(row.currentProvider) ?? 0) + row.currentCostEur);
    currentCost.set(row.currentProvider, (currentCost.get(row.currentProvider) ?? 0) + row.currentCostEur);
    targetValue.set(row.targetProvider, (targetValue.get(row.targetProvider) ?? 0) + row.currentCostEur);
    optimizedCost.set(row.targetProvider, (optimizedCost.get(row.targetProvider) ?? 0) + row.optimizedCostEur);
  }

  const currentValueTotal = sum([...currentValue.values()]);
  const targetValueTotal = sum([...targetValue.values()]);
  const optimizedCostTotal = sum([...optimizedCost.values()]);
  return [...providers]
    .map((provider) => {
      const currentVal = currentValue.get(provider) ?? 0;
      const targetVal = targetValue.get(provider) ?? 0;
      const currentShare = pct(currentVal, currentValueTotal);
      const targetShare = pct(targetVal, targetValueTotal);
      return {
        provider,
        currentWorkloadValueEur: round(currentVal),
        currentWorkloadSharePct: round(currentShare),
        targetWorkloadValueEur: round(targetVal),
        targetWorkloadSharePct: round(targetShare),
        workloadShareDeltaPctPoints: round(targetShare - currentShare),
        currentCostEur: round(currentCost.get(provider) ?? 0),
        optimizedCostEur: round(optimizedCost.get(provider) ?? 0),
        optimizedCostSharePct: round(pct(optimizedCost.get(provider) ?? 0, optimizedCostTotal)),
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
    "- Prices are public-list-price assumptions converted into EUR; they are not Aiven invoices.",
    "- Render is kept as a price reference but excluded from reroute optimization because it is PaaS, not equivalent IaaS.",
    "",
    "## Recent Cost View",
    `- Last ${args.lookbackDays} days modeled cost: **${formatMoney(last30?.modeled_cost_eur)}**; theoretical savings: **${formatMoney(last30?.theoretical_savings_eur)}**; optimized cost: **${formatMoney(last30?.optimized_cost_eur)}**.`,
    `- Previous ${args.lookbackDays} days modeled cost: **${formatMoney(previous30?.modeled_cost_eur)}**; theoretical savings: **${formatMoney(previous30?.theoretical_savings_eur)}**.`,
    `- Latest full month modeled cost: **${formatMoney(latestFullMonth?.modeled_cost_eur)}**; low-market case: **${formatMoney(latestFullMonth?.low_market_cost_eur)}**.`,
    `- Month-to-date modeled cost: **${formatMoney(monthToDate?.modeled_cost_eur)}**; theoretical savings: **${formatMoney(monthToDate?.theoretical_savings_eur)}**.`,
    "",
    "## Tomorrow Forecast",
    `- Base forecast cost: **${formatMoney(summary.forecastCurrentCostEur)}**.`,
    `- Low market case (-${formatPct(args.marketFluctuation * 100)}): **${formatMoney(summary.forecastLowMarketCostEur)}**.`,
    `- High market case (+${formatPct(args.marketFluctuation * 100)}): **${formatMoney(summary.forecastHighMarketCostEur)}**.`,
    `- Required revenue for 10% gross margin: **${formatMoney(summary.requiredRevenueFor10PctMarginEur)}**.`,
    `- Profit at 10% gross margin before changes: **${formatMoney(summary.profitAt10PctMarginEur)}**.`,
    `- Optimized cost after recommended full reroute: **${formatMoney(summary.forecastOptimizedCostEur)}**.`,
    `- Forecast savings: **${formatMoney(summary.forecastSavingsEur)}**.`,
    `- Margin after changes if revenue stays fixed: **${formatPct(summary.optimizedMarginPctIfRevenueUnchanged)}**.`,
    "",
    "## Share Changes Needed",
    "Workload share is measured on current-cost value, because raw units mix GB, GiB-hour, VM-hours, IP-hours, and storage months.",
    ...shareRows.map((row) => `- **${row.provider}**: ${formatPct(row.currentWorkloadSharePct)} -> ${formatPct(row.targetWorkloadSharePct)} workload-value share (${signed(row.workloadShareDeltaPctPoints)} pts); optimized cost share ${formatPct(row.optimizedCostSharePct)}.`),
    "",
    "## Top Tomorrow Moves",
    ...topMoves.slice(0, 15).map((row) => `- Move **${row.priceClass}** from **${row.currentProvider}** to **${row.targetProvider}**: forecast units ${formatNumber(row.forecastUnits)}, cost ${formatMoney(row.currentCostEur)} -> ${formatMoney(row.optimizedCostEur)}, save **${formatMoney(row.savingsEur)}**.`),
    "",
    "## Caveats",
    "- This is not real profit margin. It estimates the revenue needed to hit a 10% target margin because Aiven customer revenue is absent.",
    "- The model only uses the latest recency window. It intentionally ignores older history except the previous comparable window.",
    "- The largest savings are bandwidth-driven because UpCloud/Vultr-style pricing assumptions have bundled or very cheap transfer. That may not be operationally possible for managed database workloads.",
    "- The model ignores migration cost, compliance, latency, customer cloud preference, capacity reservations, and support obligations.",
    "- Cloud mapping is an educated guess from billing strings. Do not publish it as fact.",
    "",
    "## Files",
    `- Payload: \`${path.join(args.outDir, "recent_rebalancer_payload.json")}\``,
    `- Share changes: \`${path.join(args.outDir, "recommended_provider_share_changes.csv")}\``,
    `- Top moves: \`${path.join(args.outDir, "top_tomorrow_moves.csv")}\``,
    `- Tomorrow forecast: \`${path.join(args.outDir, "tomorrow_forecast_by_price_class.csv")}\``,
    `- Unit price assumptions: \`${path.join(args.outDir, "tomorrow_unit_price_assumptions.csv")}\``,
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
        <p class="lead">This report answers three questions first: current forecast cost, optimized forecast cost, and the savings worth reviewing. Supporting tables stay lower on the page.</p>
        <ol class="guide-list" aria-label="How to read this report">
          <li><strong>1</strong><span>Start with the savings number and cost change.</span></li>
          <li><strong>2</strong><span>Review the highest-impact moves before changing provider share.</span></li>
          <li><strong>3</strong><span>Use the recent-window evidence to challenge the assumption model.</span></li>
        </ol>
        <div class="hero-actions">
          <a class="button primary" href="#moves">Review actions</a>
          <a class="button ghost" href="recommended_provider_share_changes.csv">Download share plan</a>
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
            <p class="panel-copy">Modeled savings if eligible units move to the lowest equivalent public-list-price provider in this scenario.</p>
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
        <p>The table is capped to the highest-impact moves so it is easier to scan. The full forecast remains in CSV and JSON.</p>
      </div>
      <div class="table-card">
        <h3>Highest impact moves</h3>
        <div class="table-wrap">
          <table>
            <caption>Top savings opportunities by price class and provider route.</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Price class</th><th scope="col">Route</th><th scope="col">Forecast units</th><th scope="col">Current cost</th><th scope="col">Optimized cost</th><th scope="col">Savings</th></tr></thead>
            <tbody id="moves-table"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section id="shares" aria-labelledby="shares-title">
      <div class="section-heading">
        <h2 id="shares-title">Provider-share plan.</h2>
        <p>Share uses current-cost value because the raw units mix hours, storage months, GB, GiB-hours, and IP-hours.</p>
      </div>
      <div class="split-grid">
        <div class="share-card">
          <h3>Target workload share</h3>
          <div class="share-list" id="share-bars"></div>
        </div>
        <div class="table-card">
          <h3>Recommended provider share changes</h3>
          <div class="table-wrap">
            <table>
              <caption>Current and target workload-value share by provider.</caption>
              <thead><tr><th scope="col">Provider</th><th scope="col">Current share</th><th scope="col">Target share</th><th scope="col">Delta</th><th scope="col">Optimized cost share</th></tr></thead>
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
        <h2 id="latest-title">Latest day by provider.</h2>
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
          <li>Public-list prices are converted to EUR and should not be treated as real Aiven bills or true gross margin.</li>
          <li>Cloud mapping is an educated guess from billing strings. It is kept visible so assumptions can be challenged.</li>
          <li>The model ignores migration cost, latency, compliance constraints, reservations, customer cloud preferences, and support obligations.</li>
          <li>Render remains a reference price source but is excluded from reroute optimization because it is PaaS, not equivalent IaaS.</li>
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
      var moneyWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
      var moneyPrecise = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      var numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
      var pctFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

      function numeric(value) {
        var n = Number(value);
        return Number.isFinite(n) ? n : 0;
      }

      function money(value) {
        var n = numeric(value);
        return "EUR " + (Math.abs(n) < 100 ? moneyPrecise : moneyWhole).format(n);
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
      setText("hero-savings", money(summary.forecastSavingsEur));
      setText("hero-cost", money(summary.forecastCurrentCostEur));
      setText("hero-optimized", money(summary.forecastOptimizedCostEur));
      setText("hero-margin", pct(summary.optimizedMarginPctIfRevenueUnchanged));

      var savingsRate = numeric(summary.forecastCurrentCostEur) > 0
        ? (numeric(summary.forecastSavingsEur) / numeric(summary.forecastCurrentCostEur)) * 100
        : 0;
      var meter = document.getElementById("savings-meter");
      if (meter) meter.style.width = Math.min(100, Math.max(0, savingsRate)).toFixed(2) + "%";
      setText("savings-rate", pct(savingsRate));
      setText("decision-note", "Review " + money(summary.forecastSavingsEur) + " of modeled savings before changing provider share. This is an assumption model, so validate the top actions against latency, compliance, capacity, and customer preference.");

      var summaryCards = document.getElementById("summary-cards");
      if (summaryCards) {
        appendMetric(summaryCards, "Current forecast", money(summary.forecastCurrentCostEur), "Tomorrow's modeled cost before recommended changes.", false);
        appendMetric(summaryCards, "After recommendation", money(summary.forecastOptimizedCostEur), "Modeled cost after eligible reroutes.", false);
        appendMetric(summaryCards, "Savings to review", money(summary.forecastSavingsEur), pct(savingsRate) + " of the base forecast cost.", true);
      }

      var windowCards = document.getElementById("window-cards");
      (data.windowSummary || []).forEach(function (row) {
        if (!windowCards) return;
        var card = create("article", "window-card");
        card.appendChild(create("h3", "", windowTitle(row.window_name)));
        var dl = document.createElement("dl");
        [
          ["Dates", String(row.start_date || "") + " to " + String(row.end_date || "")],
          ["Modeled cost", money(row.modeled_cost_eur)],
          ["Optimized", money(row.optimized_cost_eur)],
          ["Savings", money(row.theoretical_savings_eur)],
          ["Priced rows", pct(row.priced_row_pct)]
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
          top.appendChild(create("strong", "", String(row.provider || "Unknown")));
          top.appendChild(create("span", "", signedPctPoints(row.workloadShareDeltaPctPoints) + " pts"));
          item.appendChild(top);
          var bar = create("div", "share-meter");
          bar.setAttribute("role", "img");
          bar.setAttribute("aria-label", String(row.provider || "Unknown") + " target share " + pct(row.targetWorkloadSharePct) + ", change " + signedPctPoints(row.workloadShareDeltaPctPoints) + " points");
          var fill = document.createElement("span");
          fill.style.width = Math.min(100, Math.max(0, numeric(row.targetWorkloadSharePct))).toFixed(2) + "%";
          bar.appendChild(fill);
          item.appendChild(bar);
          item.appendChild(create("p", "share-caption", "Current " + pct(row.currentWorkloadSharePct) + " -> target " + pct(row.targetWorkloadSharePct)));
          shareBars.appendChild(item);
        }
        if (shareTable) {
          appendTableRow(shareTable, [
            String(row.provider || "Unknown"),
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
          String(row.currentProvider || "") + " -> " + String(row.targetProvider || ""),
          number(row.forecastUnits),
          money(row.currentCostEur),
          money(row.optimizedCostEur),
          money(row.savingsEur)
        ]);
      });

      var latest = document.getElementById("latest-day");
      (data.latestDay || []).slice(0, 4).forEach(function (row) {
        if (!latest) return;
        var card = create("article", "latest-card");
        card.appendChild(create("span", "", String(row.provider || "Unknown provider")));
        card.appendChild(create("strong", "", money(row.modeled_cost_eur)));
        card.appendChild(create("p", "share-caption", "Optimized " + money(row.optimized_cost_eur) + ", savings " + money(row.theoretical_savings_eur)));
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

function sqlTuple(values: unknown[]): string {
  return `(${values.map(sqlValue).join(",")})`;
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

function formatMoney(value: unknown): string {
  return `EUR ${formatNumber(numberValue(value))}`;
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
