import { createConfig, http } from "wagmi";
import { arbitrum, base, baseSepolia, gnosis, mainnet, optimism, polygon } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { forkRpcUrl } from "./fork-rpc";
import { createDevProvider, DEV_WALLET_KEY } from "./dev-provider";

// Extensions (Rabby, MetaMask, Coinbase extension...) announce themselves via EIP-6963, which wagmi
// listens for by default (`multiInjectedProviderDiscovery`); `injected()` is the `window.ethereum` fallback.
// Coinbase's passkey smart wallet (wagmi `baseAccount`) is left out until adding the agent accepts contract signatures
// (the Safe delegate flow checks plain wallet signatures only); the Coinbase Wallet extension is found via EIP-6963.
// WalletConnect is left out (needs a projectId).
// All six Safe-creation networks are known so the wallet can be asked to switch to (or add) each one.
// Fork mode keeps reads on local Anvil. Dedicated local-demo mode uses its own fixture-backed injected provider,
// leaves `window.ethereum` untouched, disables extension discovery, and fails chain reads closed to loopback.
const fork = forkRpcUrl();
const localDemo = process.env.NEXT_PUBLIC_LOCAL_DEMO === "1";
const localDemoProvider = localDemo ? createDevProvider(DEV_WALLET_KEY) : undefined;
const walletConnector = localDemo
  ? injected({ target: () => ({ id: "local-demo", name: "Local demo wallet", provider: localDemoProvider as never /* The fixture implements EIP-1193 but narrows request methods. */ }) })
  : injected();
const readTransport = (forkUrl?: string) => http(forkUrl ?? (localDemo ? "http://127.0.0.1:1" : undefined));

export const wagmiConfig = createConfig({
  chains: [base, baseSepolia, mainnet, arbitrum, optimism, polygon, gnosis],
  connectors: [walletConnector],
  multiInjectedProviderDiscovery: !fork && !localDemo,
  transports: {
    [base.id]: readTransport(fork ?? undefined),
    [baseSepolia.id]: readTransport(),
    [mainnet.id]: readTransport(),
    [arbitrum.id]: readTransport(),
    [optimism.id]: readTransport(),
    [polygon.id]: readTransport(),
    [gnosis.id]: readTransport(),
  },
  ssr: true,
});
