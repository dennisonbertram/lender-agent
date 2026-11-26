// The one network-fee formula. The plan's test run and the proposal's execute data both price a Safe transaction as
// (gas it will use) x (gas price now) x (ETH price), so the plan card and the last signer's page show one figure.
// The 1.2x gas LIMIT the sender's wallet is given is a cap, not a cost, and is never part of the shown fee.
export const networkFeeUsd = (gas: bigint, gasPriceWei: bigint, ethUsd: number): number => (Number(gas) * Number(gasPriceWei) / 1e18) * ethUsd;

/** The fee line of the execute data: the same formula, ETH and cents. USD is null when the ETH price is unknown. */
export const networkFee = (gas: bigint, gasPriceWei: bigint, ethUsd: number | null): { eth: string; usd: number | null } => ({
  eth: (Number(gas) * Number(gasPriceWei) / 1e18).toString(),
  usd: ethUsd === null ? null : Math.round(networkFeeUsd(gas, gasPriceWei, ethUsd) * 100) / 100,
});

/** Mock mode (`MOCK=1`): the same gas and gas price for the plan's test run and for execute data (about $0.02 at ETH $3,000; `mockExecDeps` uses them too). */
export const MOCK_TX_GAS = 450_000n;
export const MOCK_GAS_PRICE_WEI = 15_000_000n;
