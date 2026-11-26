// Thin fetch client over Safe's hosted Transaction Service (shapes recorded in M0-1 and M0-3).
import { getAddress } from "viem";
import type { Address, ChainId, Hex, SafeTx } from "@/shared/types";

/** The hosted service rejects lowercase addresses ("Checksum address validation failed", 422): checksum every one we send. */
const cs = (a: Address) => getAddress(a);

export class SafeServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Safe Transaction Service answered ${status}`);
    this.name = "SafeServiceError";
  }
}

export type SafeInfo = {
  address: Address;
  nonce: number;
  threshold: number;
  owners: Address[];
  masterCopy?: Address;
  fallbackHandler?: Address;
  version?: string;
};

export type Delegate = {
  safe: Address | null;
  delegate: Address;
  delegator: Address;
  label: string;
  expiryDate?: string | null;
};

export type Confirmation = { owner: Address; submissionDate: string; signature?: Hex };

export type MultisigTransaction = {
  safe: Address;
  to: Address;
  value: string;
  data: Hex | null;
  operation: 0 | 1;
  safeTxGas: number | string;
  baseGas: number | string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: number;
  safeTxHash: Hex;
  /** The owner who registered the delegate when a delegate proposed (M0-1). */
  proposer: Address | null;
  /** The delegate that proposed; null for an owner proposal. Use this to find the agent's proposals. */
  proposedByDelegate: Address | null;
  origin: string | Record<string, unknown> | null;
  isExecuted: boolean;
  isSuccessful: boolean | null;
  transactionHash: Hex | null;
  confirmations: Confirmation[];
  submissionDate?: string;
};

export interface SafeService {
  getSafesByOwner(owner: Address): Promise<Address[]>;
  /** null when the service does not know the Safe (not deployed or not indexed yet). */
  getSafe(safe: Address): Promise<SafeInfo | null>;
  listDelegates(safe: Address): Promise<Delegate[]>;
  addDelegate(p: { safe: Address; delegate: Address; delegator: Address; label: string; signature: Hex }): Promise<void>;
  removeDelegate(p: { safe: Address; delegate: Address; delegator: Address; signature: Hex }): Promise<void>;
  /** The service answers 201 with an empty body: the caller computes the hash itself. */
  proposeTransaction(p: {
    safe: Address;
    tx: SafeTx;
    safeTxHash: Hex;
    sender: Address;
    signature: Hex;
    origin?: string | Record<string, unknown>;
  }): Promise<void>;
  /** An owner's confirmation: `POST /multisig-transactions/{hash}/confirmations/`. 4xx with the service's reason. */
  confirmTransaction(p: { safeTxHash: Hex; signature: Hex }): Promise<void>;
  /** null on 404 (never proposed, or deleted). */
  getMultisigTransaction(safeTxHash: Hex): Promise<MultisigTransaction | null>;
  deleteTransaction(safeTxHash: Hex, signature: Hex): Promise<void>;
}

export const DEFAULT_SERVICE_URLS: Record<ChainId, string> = {
  8453: "https://safe-transaction-base.safe.global",
  84532: "https://safe-transaction-base-sepolia.safe.global",
  42161: "https://safe-transaction-arbitrum.safe.global",
};

export function serviceUrlFor(chainId: ChainId, env: Record<string, string | undefined> = process.env): string {
  return env[`SAFE_TX_SERVICE_URL_${chainId}`] || DEFAULT_SERVICE_URLS[chainId];
}

export type SafeServiceClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
};

export class SafeServiceClient implements SafeService {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: SafeServiceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
  }

  static forChain(chainId: ChainId, env: Record<string, string | undefined> = process.env, f?: typeof fetch) {
    return new SafeServiceClient({ baseUrl: serviceUrlFor(chainId, env), apiKey: env.SAFE_API_KEY || undefined, fetch: f });
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    return { status: res.status, json };
  }

  private async expect(method: string, path: string, ok: number[], body?: unknown, allow404 = false) {
    const r = await this.request(method, path, body);
    if (allow404 && r.status === 404) return null;
    if (!ok.includes(r.status)) throw new SafeServiceError(r.status, r.json, `${method} ${path} -> ${r.status}`);
    return r;
  }

  async getSafesByOwner(owner: Address): Promise<Address[]> {
    const r = await this.expect("GET", `/api/v1/owners/${cs(owner)}/safes/`, [200]);
    return ((r!.json as { safes?: Address[] })?.safes ?? []) as Address[];
  }

  async getSafe(safe: Address): Promise<SafeInfo | null> {
    const r = await this.expect("GET", `/api/v1/safes/${cs(safe)}/`, [200], undefined, true);
    return r ? (r.json as SafeInfo) : null;
  }

  async listDelegates(safe: Address): Promise<Delegate[]> {
    const out: Delegate[] = [];
    let path: string | null = `/api/v2/delegates/?safe=${cs(safe)}`;
    while (path) {
      const r = await this.expect("GET", path, [200]);
      const page = r!.json as { results?: Delegate[]; next?: string | null };
      out.push(...(page.results ?? []));
      path = page.next ? page.next.replace(this.baseUrl, "") : null;
    }
    return out;
  }

  async addDelegate(p: { safe: Address; delegate: Address; delegator: Address; label: string; signature: Hex }) {
    await this.expect("POST", "/api/v2/delegates/", [201], {
      safe: cs(p.safe),
      delegate: cs(p.delegate),
      delegator: cs(p.delegator),
      label: p.label,
      signature: p.signature,
    });
  }

  async removeDelegate(p: { safe: Address; delegate: Address; delegator: Address; signature: Hex }) {
    await this.expect("DELETE", `/api/v2/delegates/${cs(p.delegate)}/`, [204], {
      safe: cs(p.safe),
      delegator: cs(p.delegator),
      signature: p.signature,
    });
  }

  async proposeTransaction(p: {
    safe: Address;
    tx: SafeTx;
    safeTxHash: Hex;
    sender: Address;
    signature: Hex;
    origin?: string | Record<string, unknown>;
  }) {
    await this.expect("POST", `/api/v2/safes/${cs(p.safe)}/multisig-transactions/`, [201], {
      to: cs(p.tx.to),
      value: p.tx.value,
      data: p.tx.data,
      operation: p.tx.operation,
      safeTxGas: p.tx.safeTxGas,
      baseGas: p.tx.baseGas,
      gasPrice: p.tx.gasPrice,
      gasToken: cs(p.tx.gasToken),
      refundReceiver: cs(p.tx.refundReceiver),
      nonce: p.tx.nonce,
      contractTransactionHash: p.safeTxHash,
      sender: cs(p.sender),
      signature: p.signature,
      ...(p.origin === undefined ? {} : { origin: p.origin }),
    });
  }

  async getMultisigTransaction(safeTxHash: Hex): Promise<MultisigTransaction | null> {
    const r = await this.expect("GET", `/api/v1/multisig-transactions/${safeTxHash}/`, [200], undefined, true);
    return r ? (r.json as MultisigTransaction) : null;
  }

  async confirmTransaction(p: { safeTxHash: Hex; signature: Hex }) {
    await this.expect("POST", `/api/v1/multisig-transactions/${p.safeTxHash}/confirmations/`, [200, 201], { signature: p.signature });
  }

  async deleteTransaction(safeTxHash: Hex, signature: Hex) {
    await this.expect("DELETE", `/api/v1/multisig-transactions/${safeTxHash}/`, [204], { signature });
  }
}
