// @ts-nocheck
/**
 * Soak test harness for long-running protocol services (ASP, Publisher, Relayer).
 *
 * Runs all three services under continuous representative load and records the
 * resources the *services* consume: RSS and open file descriptors are read from each
 * service's own PID on every tick and aggregated across the three. The harness's own
 * process is reported separately and never counted against the memory limit — a leak
 * in a service only shows up if the services are the thing being measured, not the
 * `execSync` wrapper doing the measuring.
 *
 * Each service is spawned directly (`node --import tsx <script>` from its own
 * workspace) rather than through `npx`, so the PID the harness measures is the service
 * process itself and SIGTERM reaches the service instead of an npm wrapper. This needs
 * each service workspace's dev dependencies installed (`npm ci --prefix asp`, etc.).
 *
 * Memory and handle growth are recorded at regular intervals. Failures produce
 * actionable diagnostics.
 *
 * Usage:
 *   tsx scripts/soak-test.ts --duration 48h
 *   tsx scripts/soak-test.ts --duration 2h --tick-interval 30s
 *
 * Environment:
 *   SOAK_DURATION        Total run time (default: 48h). Supports <n>s, <n>m, <n>h.
 *   SOAK_TICK_INTERVAL   Interval between service ticks (default: 10s).
 *   SOAK_REPORT_DIR      Directory for resource snapshots (default: target/soak/).
 *   SOAK_MEMORY_LIMIT    Max aggregate service RSS in MB before abort (default: 2048).
 *   DEPLOYER_SECRET      Stellar deployer secret for testnet operations.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

function parseDuration(raw: string): number {
  const m = raw.match(/^(\d+)(s|m|h)$/);
  if (!m) return 48 * 3600;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    default: return 48 * 3600;
  }
}

const DURATION_S = parseDuration(process.env.SOAK_DURATION ?? process.argv.find((a) => a.startsWith("--duration="))?.split("=")[1] ?? "48h");
const TICK_INTERVAL_S = parseDuration(process.env.SOAK_TICK_INTERVAL ?? process.argv.find((a) => a.startsWith("--tick-interval="))?.split("=")[1] ?? "10s");
const REPORT_DIR = process.env.SOAK_REPORT_DIR ?? join(process.cwd(), "target", "soak");
const MEMORY_LIMIT_MB = parseInt(process.env.SOAK_MEMORY_LIMIT ?? "2048", 10);
const START_TIME = Date.now();
const PAGE_SIZE_BYTES = 4096;

// ── Helpers ─────────────────────────────────────────────────────────────────

function elapsed(): string {
  const s = Math.floor((Date.now() - START_TIME) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** RSS of the harness process — reported for context only, never leak-checked. */
function getHarnessMemory(): { rssMB: number; heapUsedMB: number } {
  const mem = process.memoryUsage();
  return {
    rssMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
  };
}

/**
 * RSS of another process, in MB, or null when it cannot be read.
 * Linux reads /proc/<pid>/statm (resident pages); elsewhere falls back to `ps`.
 */
function readRssMB(pid: number): number | null {
  try {
    const residentPages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/)[1]);
    if (Number.isFinite(residentPages) && residentPages > 0) {
      return Math.round((residentPages * PAGE_SIZE_BYTES) / 1024 / 1024);
    }
  } catch {
    /* no /proc (macOS/BSD), or the process exited between ticks */
  }
  try {
    const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    if (Number.isFinite(kb) && kb > 0) return Math.round(kb / 1024);
  } catch {
    /* process is gone */
  }
  return null;
}

/**
 * Open file descriptors of another process, or null when unsupported.
 * Only Linux exposes another process's fd table (/proc/<pid>/fd); reporting 0 on
 * other platforms would read as "no leak" when it actually means "not measured".
 */
function readOpenFds(pid: number): number | null {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null;
  }
}

// ── Services ────────────────────────────────────────────────────────────────

interface ServiceDef {
  name: string;
  cwd: string;
  script: string;
}

interface ServiceState extends ServiceDef {
  process: ChildProcess | null;
  exitCode: number | null;
  restarts: number;
}

function isRunning(svc: ServiceState): boolean {
  return svc.process !== null && svc.exitCode === null && !svc.process.killed;
}

function spawnService(svc: ServiceState): ChildProcess {
  // Spawn the service process itself — no npx/npm wrapper — so the measured PID and
  // the process SIGTERM reaches are the service.
  const proc = spawn(process.execPath, ["--import", "tsx", svc.script], {
    cwd: svc.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  const logPath = join(REPORT_DIR, `${svc.name}.log`);
  proc.stdout?.on("data", (d) => appendFileSync(logPath, d));
  proc.stderr?.on("data", (d) => appendFileSync(logPath, d));
  proc.on("error", (err) => {
    svc.exitCode = -1;
    console.log(`[${elapsed()}] ${svc.name} failed to start: ${err.message}`);
  });
  proc.on("exit", (code) => {
    svc.exitCode = code;
    console.log(`[${elapsed()}] ${svc.name} exited with code ${code}`);
  });
  svc.process = proc;
  svc.exitCode = null;
  return proc;
}

function startService(def: ServiceDef): ServiceState {
  const svc: ServiceState = { ...def, process: null, exitCode: null, restarts: 0 };
  spawnService(svc);
  return svc;
}

function restartService(svc: ServiceState): void {
  svc.restarts++;
  appendFileSync(
    join(REPORT_DIR, "restarts.log"),
    `[${elapsed()}] Restarting ${svc.name} (restart #${svc.restarts}, previous exit code ${svc.exitCode})\n`,
  );
  spawnService(svc);
}

// ── Sampling ────────────────────────────────────────────────────────────────

interface ServiceSample {
  pid: number | null;
  running: boolean;
  rssMB: number | null;
  openFds: number | null;
  exitCode: number | null;
  restarts: number;
}

interface Sample {
  perService: Record<string, ServiceSample>;
  /** Aggregate service RSS in MB, or null when no service could be measured. */
  rssMB: number | null;
  /** Aggregate open fds, or null on platforms without /proc. */
  openFds: number | null;
  /** How many of the running services contributed to the aggregates. */
  rssMeasured: number;
  fdsMeasured: number;
  running: number;
  harness: { rssMB: number; heapUsedMB: number };
}

/** Reads every service's own RSS/fd count once; never the harness's. */
function sampleServices(services: ServiceState[]): Sample {
  const perService: Record<string, ServiceSample> = {};
  let rssTotal = 0;
  let rssMeasured = 0;
  let fdsTotal = 0;
  let fdsMeasured = 0;
  let running = 0;

  for (const svc of services) {
    const alive = isRunning(svc);
    const pid = alive ? svc.process!.pid ?? null : null;
    const rssMB = pid !== null ? readRssMB(pid) : null;
    const openFds = pid !== null ? readOpenFds(pid) : null;
    if (alive) running++;
    if (rssMB !== null) {
      rssTotal += rssMB;
      rssMeasured++;
    }
    if (openFds !== null) {
      fdsTotal += openFds;
      fdsMeasured++;
    }
    perService[svc.name] = { pid, running: alive, rssMB, openFds, exitCode: svc.exitCode, restarts: svc.restarts };
  }

  return {
    perService,
    rssMB: rssMeasured > 0 ? rssTotal : null,
    openFds: fdsMeasured > 0 ? fdsTotal : null,
    rssMeasured,
    fdsMeasured,
    running,
    harness: getHarnessMemory(),
  };
}

function recordSnapshot(sample: Sample): void {
  const snap = {
    timestamp: new Date().toISOString(),
    elapsed: elapsed(),
    services: sample.perService,
    totals: {
      rssMB: sample.rssMB,
      openFds: sample.openFds,
      rssMeasured: sample.rssMeasured,
      fdsMeasured: sample.fdsMeasured,
      running: sample.running,
    },
    harness: sample.harness,
  };
  appendFileSync(join(REPORT_DIR, "snapshots.jsonl"), `${JSON.stringify(snap)}\n`);
}

function describeServices(services: ServiceState[]): string {
  return services
    .map((svc) => {
      const s = sampleServices([svc]);
      const one = s.perService[svc.name];
      return `${svc.name}: rss=${one.rssMB ?? "n/a"}MB fds=${one.openFds ?? "n/a"} running=${one.running}`;
    })
    .join("  ");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const summaryPath = join(REPORT_DIR, "summary.json");

  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  Soak Test Harness");
  console.log(`  Duration:     ${DURATION_S}s (${(DURATION_S / 3600).toFixed(1)}h)`);
  console.log(`  Tick:         ${TICK_INTERVAL_S}s`);
  console.log(`  Memory limit: ${MEMORY_LIMIT_MB} MB aggregate service RSS`);
  console.log(`  Report dir:   ${REPORT_DIR}`);
  console.log("══════════════════════════════════════════════════════════════════");

  const repoRoot = join(import.meta.dirname ?? process.cwd(), "..");
  const defs: ServiceDef[] = [
    { name: "asp", cwd: join(repoRoot, "asp"), script: "scripts/indexer.ts" },
    { name: "publisher", cwd: join(repoRoot, "publisher"), script: "scripts/publisher.ts" },
    { name: "relayer-hub", cwd: join(repoRoot, "relayer"), script: "scripts/hub.ts" },
  ];

  for (const def of defs) {
    if (!existsSync(join(def.cwd, "node_modules", "tsx"))) {
      console.warn(
        `⚠ ${def.name}: no tsx in ${join(def.cwd, "node_modules")} — run \`npm ci --prefix ${def.name}\` first.`,
      );
    }
  }

  const services = defs.map(startService);

  // Baseline for the leak check: taken after the first tick so the services have
  // finished booting (a t=0 reading would understate steady-state usage).
  let baseline: Sample | null = null;
  const peakRssByService: Record<string, number> = {};
  let peakRss = 0;
  let peakHandles = 0;
  let fdsSupported = false;

  const endTime = START_TIME + DURATION_S * 1000;
  let tickCount = 0;
  let aborted = false;
  let abortReason: string | null = null;

  while (Date.now() < endTime) {
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_S * 1000));
    tickCount++;

    const sample = sampleServices(services);
    if (!baseline) baseline = sample;
    if (sample.openFds !== null) fdsSupported = true;

    for (const [name, s] of Object.entries(sample.perService)) {
      if (s.rssMB !== null && s.rssMB > (peakRssByService[name] ?? 0)) peakRssByService[name] = s.rssMB;
    }
    if (sample.rssMB !== null && sample.rssMB > peakRss) peakRss = sample.rssMB;
    if (sample.openFds !== null && sample.openFds > peakHandles) peakHandles = sample.openFds;

    // Check the memory limit against the services, not the harness.
    if (sample.rssMB !== null && sample.rssMB > MEMORY_LIMIT_MB) {
      abortReason = `aggregate service RSS ${sample.rssMB} MB exceeds limit ${MEMORY_LIMIT_MB} MB (${describeServices(services)})`;
      console.error(`[${elapsed()}] ABORT: ${abortReason}`);
      aborted = true;
      recordSnapshot(sample);
      break;
    }

    // Restart any service that exited (crash, or OOM kill) — an exited child is not
    // `killed`, so liveness has to come from the recorded exit code.
    for (const svc of services) {
      if (!isRunning(svc)) {
        console.log(`[${elapsed()}] ${svc.name} is down (exit=${svc.exitCode}) — restarting`);
        restartService(svc);
      }
    }

    // Log periodic status.
    if (tickCount % 60 === 0) {
      console.log(
        `[${elapsed()}] tick=${tickCount} rss=${sample.rssMB ?? "n/a"}MB ` +
          `(${[...Object.entries(sample.perService)]
            .map(([n, s]) => `${n}=${s.rssMB ?? "n/a"}MB`)
            .join(" ")}) peak_rss=${peakRss}MB`,
      );
    }

    recordSnapshot(sample);
  }

  // Final diagnostics.
  const finalSample = sampleServices(services);
  if (!baseline) {
    // Run shorter than one tick: no steady state to compare against.
    baseline = finalSample;
  }
  const memoryDelta = baseline.rssMB === null || finalSample.rssMB === null ? null : finalSample.rssMB - baseline.rssMB;
  const handleDelta =
    baseline.openFds === null || finalSample.openFds === null ? null : finalSample.openFds - baseline.openFds;

  const summary = {
    startTime: new Date(START_TIME).toISOString(),
    endTime: new Date().toISOString(),
    durationSeconds: DURATION_S,
    tickCount,
    aborted,
    abortReason,
    /** Aggregates cover the services only; the harness is reported on its own. */
    servicesTotal: {
      rssMB: { start: baseline.rssMB, end: finalSample.rssMB, deltaMB: memoryDelta, peakMB: peakRss },
      openFds: { start: baseline.openFds, end: finalSample.openFds, delta: handleDelta, peak: peakHandles },
      measured: { rss: finalSample.rssMeasured, fds: finalSample.fdsMeasured },
      fdsSupported,
    },
    services: Object.fromEntries(
      services.map((s) => {
        const start = baseline!.perService[s.name];
        const end = finalSample.perService[s.name];
        return [
          s.name,
          {
            startMB: start.rssMB,
            endMB: end.rssMB,
            deltaMB: start.rssMB === null || end.rssMB === null ? null : end.rssMB - start.rssMB,
            peakMB: peakRssByService[s.name] ?? null,
            openFds: end.openFds,
            restarts: s.restarts,
            finalExitCode: s.exitCode,
            running: end.running,
          },
        ];
      }),
    ),
    harness: finalSample.harness,
  };

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  const signed = (v: number | null, suffix: string) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v}${suffix}`);

  console.log("");
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  Soak Test Complete");
  console.log(`  Duration:       ${elapsed()}`);
  console.log(`  Ticks:          ${tickCount}`);
  console.log(`  Peak RSS:       ${peakRss} MB (services, aggregate)`);
  console.log(`  RSS delta:      ${signed(memoryDelta, " MB")} (services, vs first tick)`);
  console.log(`  Peak handles:   ${fdsSupported ? peakHandles : "n/a (no /proc on this platform)"}`);
  console.log(`  Handle delta:   ${fdsSupported ? signed(handleDelta, "") : "n/a (no /proc on this platform)"}`);
  console.log(`  Service restarts: ${services.reduce((a, s) => a + s.restarts, 0)}`);
  for (const svc of services) {
    const stats = summary.services[svc.name];
    console.log(
      `    ${svc.name}: rss ${stats.startMB ?? "n/a"}MB → ${stats.endMB ?? "n/a"}MB ` +
        `(${signed(stats.deltaMB, "MB")}, peak ${stats.peakMB ?? "n/a"}MB), ` +
        `fds ${stats.openFds ?? "n/a"}, ${stats.restarts} restarts, exit=${svc.exitCode}`,
    );
  }
  console.log(`  Harness RSS:    ${finalSample.harness.rssMB} MB (not measured against the limit)`);
  if (finalSample.rssMeasured < services.length) {
    console.warn(
      `  ⚠ Only ${finalSample.rssMeasured}/${services.length} services were measurable; the aggregate above is a lower bound.`,
    );
  }
  console.log(`  Summary:        ${summaryPath}`);
  console.log(`  Snapshots:      ${join(REPORT_DIR, "snapshots.jsonl")}`);
  console.log("══════════════════════════════════════════════════════════════════");

  // Cleanup: kill all spawned services.
  for (const svc of services) {
    if (svc.process && !svc.process.killed) {
      svc.process.kill("SIGTERM");
    }
  }

  process.exit(aborted ? 1 : 0);
}

main().catch((err) => {
  console.error("Soak test failed:", err);
  process.exit(1);
});
