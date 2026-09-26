/**
 * Pluggable inclusion policy engine. Operators register named policies that receive
 * deposit context and return an auditable decision. The engine composes policies via
 * a configurable strategy (e.g., "any approve wins", "all must approve", "first decides").
 *
 * Ships with the approve-all reference policy as the default so operators who do not
 * need custom screening get working behaviour out of the box.
 */
import type { Deposit, Policy, PolicyVerdict } from "./types.ts";

export interface PolicyDecision {
  policy: string;
  deposit: Deposit;
  verdict: PolicyVerdict;
  reason: string;
  timestamp: string;
}

export interface PolicyEngineConfig {
  /** Ordered list of policies to evaluate. */
  policies: Policy[];
  /**
   * Composition strategy:
   * - "first-decides"   — first non-defer verdict wins (default, fast-path)
   * - "any-approve"     — approve if any policy approves
   * - "all-must-approve" — approve only if every policy approves
   */
  strategy?: "first-decides" | "any-approve" | "all-must-approve";
  /** Optional callback invoked for every decision (audit log, metrics, etc.). */
  onDecision?: (decision: PolicyDecision) => void;
}

/**
 * A composable policy engine that evaluates deposits against a chain of policies.
 */
export class PolicyEngine {
  readonly policies: Policy[];
  private strategy: PolicyEngineConfig["strategy"];
  private onDecision?: (decision: PolicyDecision) => void;

  constructor(config: PolicyEngineConfig) {
    if (config.policies.length === 0) {
      throw new Error("PolicyEngine requires at least one policy");
    }
    this.policies = [...config.policies];
    this.strategy = config.strategy ?? "first-decides";
    this.onDecision = config.onDecision;
  }

  /** Human-readable engine descriptor. */
  get name(): string {
    return `policy-engine(${this.policies.map((p) => p.name).join(",")})`;
  }

  async screen(deposit: Deposit): Promise<PolicyVerdict> {
    return (await this.evaluate(deposit)).verdict;
  }

  async evaluate(deposit: Deposit): Promise<{ verdict: PolicyVerdict; decisions: PolicyDecision[] }> {
    const results: PolicyDecision[] = [];
    const ts = new Date().toISOString();

    for (const policy of this.policies) {
      const verdict = await policy.screen(deposit);
      const reason = policy.reason?.(deposit) ?? `policy returned ${verdict}`;
      const decision: PolicyDecision = { policy: policy.name, deposit, verdict, reason, timestamp: ts };
      results.push(decision);
      if (this.onDecision) this.onDecision(decision);
    }

    switch (this.strategy) {
      case "any-approve":
        return { verdict: results.some((r) => r.verdict === "approve") ? "approve" : results.some((r) => r.verdict === "defer") ? "defer" : "reject", decisions: results };
      case "all-must-approve":
        return { verdict: results.some((r) => r.verdict === "reject") ? "reject" : results.every((r) => r.verdict === "approve") ? "approve" : "defer", decisions: results };
      case "first-decides":
      default:
        for (const r of results) {
          if (r.verdict !== "defer") return { verdict: r.verdict, decisions: results };
        }
        return { verdict: "defer", decisions: results };
    }
  }
}
