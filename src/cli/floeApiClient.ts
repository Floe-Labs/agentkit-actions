/**
 * Minimal HTTP client for the Floe Developer API.
 *
 * Wraps the wallet-signature auth flow so the CLI subcommands can
 * stay focused on UX. All methods construct fresh auth headers per
 * request (timestamps drift, so cached headers wouldn't survive
 * past the 5-minute window anyway).
 */
import type { EvmWalletProvider } from "@coinbase/agentkit";
import { buildAuthHeaders } from "./signatureAuth.js";

export interface CreateAgentInput {
  name: string;
  borrowLimitRaw: string;
  maxRateBps: number;
  expirySeconds: number;
}

export interface CreateAgentResponse {
  agentId: number;
  status: string;
  privyWalletAddress: string;
  delegationTxHash: string;
}

export interface CreateKeyResponse {
  key: string;
  id: number;
  keyPrefix: string;
  label: string | null;
  permissions: string;
  createdAt: string;
}

export interface ListedKey {
  id: number;
  keyPrefix: string;
  label: string | null;
  permissions: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface OpenCreditLineInput {
  depositRaw: string;
  maxLtvBps?: number;
  maxRateBps?: number;
}

export interface OpenCreditLineResponse {
  loanId: string;
  borrowIntentHash: string | null;
  approveTxHash: string | null;
  registerTxHash: string;
  principalRaw: string;
  collateralAmountRaw: string;
  rateBps: number;
  status: "pending_on_chain";
}

const FETCH_TIMEOUT_MS = 30_000;

async function callWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string; message?: string };
    return body.detail || body.error || body.message || res.statusText;
  } catch {
    return res.statusText;
  }
}

export class FloeApiClient {
  private readonly baseUrl: string;

  constructor(
    facilitatorUrl: string,
    private readonly walletProvider: EvmWalletProvider,
  ) {
    this.baseUrl = facilitatorUrl.replace(/\/+$/, "");
  }

  async createAgent(input: CreateAgentInput): Promise<CreateAgentResponse> {
    const headers = await buildAuthHeaders(this.walletProvider);
    const res = await callWithTimeout(`${this.baseUrl}/v1/developer/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`createAgent: ${res.status} ${await readError(res)}`);
    return (await res.json()) as CreateAgentResponse;
  }

  async createAgentKey(
    agentId: number,
    label?: string,
    permissions?: "read" | "read_write",
  ): Promise<CreateKeyResponse> {
    const headers = await buildAuthHeaders(this.walletProvider);
    const body: Record<string, string> = {};
    if (label !== undefined) body.label = label;
    if (permissions !== undefined) body.permissions = permissions;
    const res = await callWithTimeout(
      `${this.baseUrl}/v1/developer/agents/${agentId}/keys`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`createAgentKey: ${res.status} ${await readError(res)}`);
    return (await res.json()) as CreateKeyResponse;
  }

  async listAgentKeys(agentId: number): Promise<ListedKey[]> {
    const headers = await buildAuthHeaders(this.walletProvider);
    const res = await callWithTimeout(
      `${this.baseUrl}/v1/developer/agents/${agentId}/keys`,
      { method: "GET", headers },
    );
    if (!res.ok) throw new Error(`listAgentKeys: ${res.status} ${await readError(res)}`);
    const body = (await res.json()) as { keys: ListedKey[] };
    return body.keys;
  }

  async revokeAgentKey(agentId: number, keyId: number): Promise<void> {
    const headers = await buildAuthHeaders(this.walletProvider);
    const res = await callWithTimeout(
      `${this.baseUrl}/v1/developer/agents/${agentId}/keys/${keyId}`,
      { method: "DELETE", headers },
    );
    if (!res.ok) throw new Error(`revokeAgentKey: ${res.status} ${await readError(res)}`);
  }

  async rotateAgentKey(
    agentId: number,
    keyId: number,
  ): Promise<CreateKeyResponse> {
    const headers = await buildAuthHeaders(this.walletProvider);
    const res = await callWithTimeout(
      `${this.baseUrl}/v1/developer/agents/${agentId}/keys/${keyId}/rotate`,
      { method: "POST", headers, body: "{}" },
    );
    if (!res.ok) throw new Error(`rotateAgentKey: ${res.status} ${await readError(res)}`);
    return (await res.json()) as CreateKeyResponse;
  }

  async openCreditLine(
    agentId: number,
    input: OpenCreditLineInput,
  ): Promise<OpenCreditLineResponse> {
    const headers = await buildAuthHeaders(this.walletProvider);
    const res = await callWithTimeout(
      `${this.baseUrl}/v1/developer/agents/${agentId}/open-credit-line`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) throw new Error(`openCreditLine: ${res.status} ${await readError(res)}`);
    return (await res.json()) as OpenCreditLineResponse;
  }
}
