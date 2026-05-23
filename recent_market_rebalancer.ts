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

  const output = {
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
    windowSummary,
    latestDay,
  };

  await writeCsv(path.join(args.outDir, "recent_window_summary.csv"), windowSummary);
  await writeCsv(path.join(args.outDir, "latest_day_by_provider.csv"), latestDay);
  await writeCsv(path.join(args.outDir, "tomorrow_forecast_by_price_class.csv"), forecastRows);
  await writeCsv(path.join(args.outDir, "recommended_provider_share_changes.csv"), shareRows);
  await writeCsv(path.join(args.outDir, "top_tomorrow_moves.csv"), topMoves);
  await writeCsv(path.join(args.outDir, "tomorrow_unit_price_assumptions.csv"), providerPricesForTomorrow);
  await writeCsv(path.join(args.outDir, "cloud_mapping_assumptions_ts.csv"), cloudMap);
  await writeFile(path.join(args.outDir, "recent_rebalancer_payload.json"), JSON.stringify(output, jsonReplacer, 2), "utf8");
  await writeFile(path.join(args.outDir, "recent_market_rebalancer_report.md"), buildReport(output, args), "utf8");

  console.log("Created recent-market TypeScript rebalancing report");
  console.log(`Output folder: ${args.outDir}`);
  console.log(`Report: ${path.join(args.outDir, "recent_market_rebalancer_report.md")}`);
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

function buildForecastSummary(rows: ForecastRow[], args: Args) {
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

function buildReport(output: any, args: Args): string {
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
