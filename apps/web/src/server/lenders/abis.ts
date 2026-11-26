// ABIs for the lender contracts the adapters touch (Compound v3 Comet, Morpho Blue). Aave's are in chain/abis.ts.
import { parseAbi } from "viem";

const MARKET_PARAMS = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";

export const cometAbi = parseAbi([
  "function baseToken() view returns (address)",
  "function baseTokenPriceFeed() view returns (address)",
  "function numAssets() view returns (uint8)",
  "function getAssetInfo(uint8 i) view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))",
  "function getAssetInfoByAddress(address asset) view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))",
  "function getPrice(address priceFeed) view returns (uint256)",
  "function userCollateral(address account, address asset) view returns (uint128 balance, uint128 reserved)",
  "function totalsCollateral(address asset) view returns (uint128 totalSupplyAsset, uint128 reserved)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function isLiquidatable(address account) view returns (bool)",
  "function baseBorrowMin() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalBorrow() view returns (uint256)",
  "function getUtilization() view returns (uint256)",
  "function getBorrowRate(uint256 utilization) view returns (uint64)",
  "function isSupplyPaused() view returns (bool)",
  "function isWithdrawPaused() view returns (bool)",
  "function supply(address asset, uint256 amount)",
  "function supplyTo(address dst, address asset, uint256 amount)",
  "function withdraw(address asset, uint256 amount)",
  "function absorb(address absorber, address[] accounts)",
]);

export const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32 id) view returns ${MARKET_PARAMS}`,
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  `function supplyCollateral(${MARKET_PARAMS} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function withdrawCollateral(${MARKET_PARAMS} marketParams, uint256 assets, address onBehalf, address receiver)`,
  `function borrow(${MARKET_PARAMS} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${MARKET_PARAMS} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function liquidate(${MARKET_PARAMS} marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) returns (uint256, uint256)`,
  `function accrueInterest(${MARKET_PARAMS} marketParams)`,
]);

export const morphoIrmAbi = parseAbi([
  `function borrowRateView(${MARKET_PARAMS} marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)`,
]);

export const morphoOracleAbi = parseAbi(["function price() view returns (uint256)"]);
