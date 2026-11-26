// A dev EIP-1193 wallet backed by a viem local account (anvil keys only). Never used with a real key.
import { createWalletClient, hexToString, http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { forkRpcUrl } from "./fork-rpc";

export const DEV_WALLET_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // anvil index 1

type Listener = (...args: unknown[]) => void;

export function createDevProvider(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  let chainId = 8453;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (ev: string, ...args: unknown[]) => listeners.get(ev)?.forEach((l) => l(...args));

  return {
    isDevWallet: true,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const p = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
        case "personal_sign": {
          // params: [message, address]
          const raw = p[0] as string;
          return account.signMessage({ message: isHex(raw) ? hexToString(raw) : raw });
        }
        case "eth_signTypedData_v4": {
          const typed = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1];
          const { EIP712Domain: _omit, ...types } = typed.types;
          return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message });
        }
        case "eth_sendTransaction": {
          // Fork mode (`NEXT_PUBLIC_FORK_RPC_URL`, a local anvil): sign with the dev key and send the real transaction.
          const forkRpc = forkRpcUrl();
          if (forkRpc) {
            const t = p[0] as { data?: Hex; to?: Hex; value?: string; gas?: string };
            return createWalletClient({ account, transport: http(forkRpc) }).sendTransaction({
              chain: null, to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined,
            });
          }
          // Mock world only: the fake Safe service and fixture chain "run" the transaction (no real chain).
          const tx = p[0] as { data?: string; to?: string; from?: string };
          const res = await fetch("/api/mock/safe-wallet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "execute-tx", chainId, data: tx.data, to: tx.to, from: tx.from ?? account.address }) });
          if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => null))?.error ?? "Mock execution failed"), { code: -32000 });
          return ((await res.json()) as { txHash: string }).txHash;
        }
        case "wallet_switchEthereumChain": {
          const next = Number.parseInt((p[0] as { chainId: string }).chainId, 16);
          if (next !== chainId) { chainId = next; emit("chainChanged", `0x${next.toString(16)}`); }
          return null;
        }
        default:
          throw Object.assign(new Error(`Dev wallet does not support ${method}`), { code: 4200 });
      }
    },
    on(ev: string, l: Listener) { (listeners.get(ev) ?? listeners.set(ev, new Set()).get(ev)!).add(l); },
    removeListener(ev: string, l: Listener) { listeners.get(ev)?.delete(l); },
  };
}

const SELECTABLE_KEYS: Record<string, Hex> = {
  "1": DEV_WALLET_KEY, // owner
  "2": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // co-signer
  "3": "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // stranger
};

/** `localStorage["la:mockWalletKey"]` picks anvil key 1, 2 or 3; anything else falls back to key 1. */
function selectedKey(): Hex {
  try {
    return SELECTABLE_KEYS[window.localStorage.getItem("la:mockWalletKey") ?? ""] ?? DEV_WALLET_KEY;
  } catch {
    return DEV_WALLET_KEY;
  }
}

/** Install the dev wallet as `window.ethereum`. Playwright calls this with the owner, co-signer or stranger key. */
export function installDevWallet(privateKey?: Hex): void {
  if (typeof window === "undefined") return;
  privateKey ??= selectedKey();
  (window as unknown as { ethereum: unknown }).ethereum = createDevProvider(privateKey);
}

/**
 * Installs the default dev wallet when `NEXT_PUBLIC_MOCK_WALLET=1`. Mock mode keeps an existing `window.ethereum`;
 * fork mode (a valid local `NEXT_PUBLIC_FORK_RPC_URL`) always replaces it, so a real extension is never used on the fork.
 */
export function maybeInstallMockWallet(): void {
  if (process.env.NEXT_PUBLIC_MOCK_WALLET !== "1" || typeof window === "undefined") return;
  if (forkRpcUrl() || !(window as unknown as { ethereum?: unknown }).ethereum) installDevWallet();
}
