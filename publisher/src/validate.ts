import { normalizeHex32 } from "./bytes.ts";
import type { LeafCommitment } from "./types.ts";

export interface ValidCommitment {
  ok: true;
  commitment: LeafCommitment;
}

export interface InvalidCommitment {
  ok: false;
  errors: string[];
}

export type CommitmentValidation = ValidCommitment | InvalidCommitment;

/// BN254 field modulus — leaf values must be strictly less than this.
const BN254_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

export function validateLeafCommitment(raw: unknown): CommitmentValidation {
  const errors: string[] = [];
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;

  if (!("leaf" in obj) || typeof obj.leaf !== "string") {
    errors.push("leaf is required and must be a string");
  } else {
    try {
      normalizeHex32(obj.leaf, "leaf");
      // Range-check: leaf value must be below the BN254 field modulus.
      const leafValue = BigInt(obj.leaf);
      if (leafValue < 0n || leafValue >= BN254_MODULUS) {
        errors.push("leaf value must be a valid BN254 field element (0 <= value < modulus)");
      }
    } catch {
      errors.push("leaf must be a 0x-prefixed 32-byte hex string");
    }
  }

  if ("id" in obj && typeof obj.id === "string") {
    const trimmed = obj.id.trim();
    if (!trimmed) errors.push("id must not be empty");
  } else if (!("attestationUid" in obj)) {
    errors.push("id is required (or provide attestationUid)");
  }

  if ("schemaId" in obj && typeof obj.schemaId === "string") {
    try {
      normalizeHex32(obj.schemaId, "schemaId");
    } catch {
      errors.push("schemaId must be a 0x-prefixed 32-byte hex string if provided");
    }
  }

  if ("attestationUid" in obj && typeof obj.attestationUid === "string") {
    try {
      normalizeHex32(obj.attestationUid, "attestationUid");
    } catch {
      errors.push("attestationUid must be a 0x-prefixed 32-byte hex string if provided");
    }
  }

  if ("ledger" in obj && obj.ledger !== undefined) {
    if (typeof obj.ledger !== "number" || !Number.isInteger(obj.ledger) || obj.ledger < 0) {
      errors.push("ledger must be a non-negative integer if provided");
    }
  }

  if ("txHash" in obj && obj.txHash !== undefined && typeof obj.txHash !== "string") {
    errors.push("txHash must be a string if provided");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const leaf = normalizeHex32(String(obj.leaf), "leaf");
  const id = String(obj.id ?? obj.attestationUid ?? leaf).trim().toLowerCase();

  return {
    ok: true,
    commitment: {
      id,
      leaf,
      schemaId: obj.schemaId ? normalizeHex32(obj.schemaId, "schemaId") : undefined,
      attestationUid: obj.attestationUid ? normalizeHex32(obj.attestationUid, "attestationUid") : undefined,
      txHash: typeof obj.txHash === "string" ? obj.txHash : undefined,
      ledger: typeof obj.ledger === "number" ? obj.ledger : undefined,
      // Server-assigned timestamp — never trust client-supplied submittedAt (#967)
      submittedAt: new Date().toISOString(),
    },
  };
}
