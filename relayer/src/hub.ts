import type { RelayerEngine } from "./engine.ts";
import type { GossipTransport } from "./gossip.ts";
import type { HubStore } from "./store.ts";
import {
  validateAdvert,
  validateBid,
  validateHeartbeat,
  validateOutcome,
  validateRelayerMessage,
  validatePayload,
  type EncryptedPayload,
  type JobAdvert,
  type RelayerBid,
  type RelayerHeartbeat,
  type RelayerMessage,
  type RelayerOutcome,
} from "./messages.ts";

export type RelayerHubStats = {
  advertsSeen: number;
  bidsSeen: number;
  payloadsSeen: number;
  outcomesSeen: number;
  heartbeatsSeen: number;
  lastError: string | null;
};

/** No heartbeat from a node within this window marks it down for failover purposes. */
export const HEARTBEAT_MISS_THRESHOLD_MS = 45_000;

/** A job whose assigned operator missed its heartbeat threshold and was handed to a different, live bidder. */
export type FailoverEvent = {
  jobId: string;
  from: string;
  to: string;
};

/** Score a brand-new relayer is shown with before it has any resolved jobs in the window. */
export const NEUTRAL_RELAYER_SCORE = 0.5;

/** How far back completed/failed jobs count toward a relayer's score. */
const SCORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Expiry time for old bids (90 days). */
const BID_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/** Expiry time for old assignments (7 days). */
const ASSIGNMENT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

type OutcomeEntry = { result: "completed" | "failed"; at: number };
type BidEntry = RelayerBid & { addedAt: number };

export type RelayerScore = {
  operator: string;
  /** Completed / (completed + failed) over the window, or NEUTRAL_RELAYER_SCORE if nothing has resolved yet. */
  score: number;
  completed: number;
  failed: number;
  windowMs: number;
};

export class RelayerHub {
  readonly stats: RelayerHubStats = {
    advertsSeen: 0,
    bidsSeen: 0,
    payloadsSeen: 0,
    outcomesSeen: 0,
    heartbeatsSeen: 0,
    lastError: null,
  };

  private bids = new Map<string, BidEntry[]>();
  private subscribers = new Set<(message: RelayerMessage) => Promise<void> | void>();
  private outcomes = new Map<string, OutcomeEntry[]>();
  private knownOperators = new Set<string>();
  private lastHeartbeatAt = new Map<string, number>();
  /** jobId -> operator currently expected to submit it (from the last payload delivery seen). */
  private assignments = new Map<string, { operator: string; addedAt: number }>();
  private failoverTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private startedAt: number;

  constructor(
    private readonly transport: GossipTransport,
    /** Called with only the job identifier — never the payload, recipient, or proof data. */
    private readonly onFailover: (jobId: string) => void = (jobId) =>
      log.warn("reassigning stalled job", { jobId }),
    private readonly store?: HubStore,
  ) {
    this.startedAt = Date.now();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.hydrateFromStore();
    await this.transport.subscribe(async (message) => {
      try {
        const valid = validateRelayerMessage(message);
        if (valid.t === "advert") {
          this.stats.advertsSeen += 1;
        } else if (valid.t === "bid") {
          this.rememberBid(valid);
          this.stats.bidsSeen += 1;
          await this.persistState();
        } else if (valid.t === "payload") {
          this.rememberAssignment(valid);
          this.stats.payloadsSeen += 1;
          await this.persistState();
        } else if (valid.t === "outcome") {
          this.recordOutcome(valid.operator, valid.result);
          const jobKey = valid.jobId.toLowerCase();
          this.assignments.delete(jobKey);
          this.bids.delete(jobKey);
          this.stats.outcomesSeen += 1;
          await this.persistState();
        } else if (valid.t === "heartbeat") {
          this.recordHeartbeat(valid.operator);
          this.stats.heartbeatsSeen += 1;
          await this.persistState();
        }
        await Promise.all(Array.from(this.subscribers, (handler) => handler(valid)));
      } catch (err) {
        this.stats.lastError = err instanceof Error ? err.message : String(err);
      }
    });
  }

  bidsFor(jobId: string): RelayerBid[] {
    return this.bids.get(jobId.toLowerCase()) ?? [];
  }

  async handleAdvert(advert: JobAdvert): Promise<null> {
    await this.publishGossipMessage(validateAdvert(advert));
    return null;
  }

  async handlePayload(payload: EncryptedPayload): Promise<null> {
    await this.publishGossipMessage(validatePayload(payload));
    return null;
  }

  async handleOutcome(outcome: RelayerOutcome): Promise<null> {
    await this.publishGossipMessage(validateOutcome(outcome));
    return null;
  }

  async handleHeartbeat(heartbeat: RelayerHeartbeat): Promise<null> {
    await this.publishGossipMessage(validateHeartbeat(heartbeat));
    return null;
  }

  async publishGossipMessage(message: RelayerMessage): Promise<void> {
    await this.start();
    await this.transport.publish(validateRelayerMessage(message));
  }

  subscribeGossip(handler: (message: RelayerMessage) => Promise<void> | void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  rememberBid(bid: RelayerBid): void {
    const key = bid.jobId.toLowerCase();
    const list = this.bids.get(key) ?? [];
    if (!list.some((b) => b.operator === bid.operator)) {
      list.push({ ...bid, addedAt: Date.now() });
      this.bids.set(key, list);
    }
    this.knownOperators.add(bid.operator);
    void this.persistState();
  }

  /** Record a resolved job for an operator. `at` defaults to now; exposed for tests. */
  recordOutcome(operator: string, result: "completed" | "failed", at: number = Date.now()): void {
    this.knownOperators.add(operator);
    const list = this.outcomes.get(operator) ?? [];
    list.push({ result, at });
    this.outcomes.set(operator, list);
    void this.persistState();
  }

  /** A payload delivery is the hub's only signal for which operator now owns a job. */
  private rememberAssignment(payload: EncryptedPayload): void {
    const key = payload.jobId.toLowerCase();
    const bid = this.bidsFor(key).find((b) => b.x25519Pk.toLowerCase() === payload.to.toLowerCase());
    if (bid) this.assignments.set(key, { operator: bid.operator, addedAt: Date.now() });
  }

  recordHeartbeat(operator: string, at: number = Date.now()): void {
    this.knownOperators.add(operator);
    this.lastHeartbeatAt.set(operator, at);
    void this.persistState();
  }

  /** A node that has never sent a heartbeat is not assumed healthy. */
  isNodeAlive(operator: string, now: number = Date.now()): boolean {
    const last = this.lastHeartbeatAt.get(operator);
    return last !== undefined && now - last <= HEARTBEAT_MISS_THRESHOLD_MS;
  }

  /**
   * Reassigns jobs whose current operator has missed the heartbeat threshold to a
   * different, live bidder on the same job. This never touches the chain — it only
   * updates which operator the hub expects to submit, so it cannot cause a double
   * submission; the pool contract's own open/accepted/submitted state machine is what
   * actually prevents two relayers from settling the same job. Only the job identifier
   * is passed to the failover logger, never the payload, recipient, or proof.
   */
  runFailoverCheck(now: number = Date.now()): FailoverEvent[] {
    const events: FailoverEvent[] = [];
    for (const [jobId, assignment] of this.assignments) {
      if (this.isNodeAlive(assignment.operator, now)) continue;
      const alt = this.bidsFor(jobId).find(
        (bid) => bid.operator !== assignment.operator && this.isNodeAlive(bid.operator, now),
      );
      if (!alt) continue;
      this.assignments.set(jobId, { operator: alt.operator, addedAt: now });
      this.onFailover(jobId);
      events.push({ jobId, from: assignment.operator, to: alt.operator });
    }
    return events;
  }

  /** Runs `runFailoverCheck` on a timer. Safe to call multiple times — only one timer runs. */
  startFailoverWatch(intervalMs: number = HEARTBEAT_MISS_THRESHOLD_MS): void {
    if (this.failoverTimer !== null) return;
    this.failoverTimer = setInterval(() => this.runFailoverCheck(), intervalMs);
  }

  stopFailoverWatch(): void {
    if (this.failoverTimer !== null) {
      clearInterval(this.failoverTimer);
      this.failoverTimer = null;
    }
  }

  /** Prune expired entries from memory maps. Runs on a timer. Safe to call multiple times. */
  startPruneWatch(intervalMs: number = 60 * 60 * 1000): void {
    if (this.pruneTimer !== null) return;
    this.pruneTimer = setInterval(() => this.prune(), intervalMs);
  }

  stopPruneWatch(): void {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private prune(now: number = Date.now()): void {
    for (const [jobId, bidList] of this.bids) {
      const fresh = bidList.filter((bid) => now - bid.addedAt < BID_EXPIRY_MS);
      if (fresh.length === 0) {
        this.bids.delete(jobId);
      } else if (fresh.length !== bidList.length) {
        this.bids.set(jobId, fresh);
      }
    }

    for (const [jobId, assignment] of this.assignments) {
      if (now - assignment.addedAt >= ASSIGNMENT_EXPIRY_MS) {
        this.assignments.delete(jobId);
      }
    }

    const cutoff = now - SCORE_WINDOW_MS;
    for (const [operator, outcomeList] of this.outcomes) {
      const fresh = outcomeList.filter((entry) => entry.at >= cutoff);
      if (fresh.length === 0) {
        this.outcomes.delete(operator);
      } else if (fresh.length !== outcomeList.length) {
        this.outcomes.set(operator, fresh);
      }
    }

    void this.persistState();
  }

  private windowedOutcomes(operator: string, now = Date.now()): OutcomeEntry[] {
    const list = this.outcomes.get(operator) ?? [];
    const cutoff = now - SCORE_WINDOW_MS;
    const fresh = list.filter((entry) => entry.at >= cutoff);
    if (fresh.length !== list.length) this.outcomes.set(operator, fresh);
    return fresh;
  }

  /**
   * A relayer's completion-rate score over the scoring window: completed jobs over
   * completed-plus-failed jobs. Relayers with no resolved jobs yet — brand new, or
   * simply idle within the window — get NEUTRAL_RELAYER_SCORE rather than 0, so an
   * unproven operator doesn't look worse than a proven bad one.
   */
  scoreFor(operator: string): RelayerScore {
    const entries = this.windowedOutcomes(operator);
    const completed = entries.filter((entry) => entry.result === "completed").length;
    const failed = entries.filter((entry) => entry.result === "failed").length;
    const resolved = completed + failed;
    return {
      operator,
      score: resolved === 0 ? NEUTRAL_RELAYER_SCORE : completed / resolved,
      completed,
      failed,
      windowMs: SCORE_WINDOW_MS,
    };
  }

  /** All known relayers' scores, highest first. */
  allScores(): RelayerScore[] {
    return Array.from(this.knownOperators, (operator) => this.scoreFor(operator)).sort(
      (a, b) => b.score - a.score || a.operator.localeCompare(b.operator),
    );
  }

  async healthCheck(): Promise<{
    ok: boolean;
    uptime: number;
    stats: RelayerHubStats;
  }> {
    return {
      ok: true,
      uptime: Date.now() - this.startedAt,
      stats: { ...this.stats },
    };
  }

  private async persistState(): Promise<void> {
    if (!this.store) return;
    try {
      const bidsForStore = Array.from(this.bids.entries()).map(([k, v]) => [k, v.map(b => ({ ...b }))]);
      const assignmentsForStore = Array.from(this.assignments.entries()).map(([k, v]) => [k, v]);
      await this.store.save({
        bids: bidsForStore,
        outcomes: Array.from(this.outcomes.entries()),
        knownOperators: Array.from(this.knownOperators),
        lastHeartbeatAt: Array.from(this.lastHeartbeatAt.entries()),
        assignments: assignmentsForStore,
        stats: { ...this.stats },
      });
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  private async hydrateFromStore(): Promise<void> {
    if (!this.store) return;
    try {
      const saved = await this.store.load();
      if (!saved) return;
      for (const [k, v] of saved.bids) this.bids.set(k, v);
      for (const [k, v] of saved.outcomes) this.outcomes.set(k, v);
      for (const op of saved.knownOperators) this.knownOperators.add(op);
      for (const [k, v] of saved.lastHeartbeatAt) this.lastHeartbeatAt.set(k, v);
      for (const [k, v] of saved.assignments) {
        this.assignments.set(k, typeof v === "string" ? { operator: v, addedAt: Date.now() } : v);
      }
      if (saved.stats) {
        this.stats.advertsSeen = saved.stats.advertsSeen;
        this.stats.bidsSeen = saved.stats.bidsSeen;
        this.stats.payloadsSeen = saved.stats.payloadsSeen;
        this.stats.outcomesSeen = saved.stats.outcomesSeen;
        this.stats.heartbeatsSeen = saved.stats.heartbeatsSeen;
      }
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}

export async function attachRelayerEngineToGossip(
  engine: RelayerEngine,
  transport: GossipTransport,
): Promise<void> {
  await transport.subscribe(async (message) => {
    if (message.t === "advert") {
      const bid = await engine.handleAdvert(message);
      if (bid) await transport.publish(bid);
      return;
    }
    if (message.t === "bid") {
      engine.rememberBid(validateBid(message));
      return;
    }
    if (message.t === "payload") {
      await engine.handlePayload(message);
    }
  });
}
