// The slice of the Zodiac Roles v2 (v2.1.x) ABI we use, written by hand so nothing depends on the
// hosted Zodiac API or on `zodiac-roles-sdk` at runtime. Checked against zodiac-roles-sdk 3.4.8's ABI.
import { parseAbi } from "viem";

/** ParameterType, Operator and ExecutionOptions numbers of Roles v2. */
export const ParamType = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 } as const;
export const Op = { Pass: 0, And: 1, Or: 2, Matches: 5, EqualTo: 16, WithinAllowance: 28 } as const;
export const ExecOptions = { None: 0, Send: 1, DelegateCall: 2, Both: 3 } as const;

export const rolesAbi = parseAbi([
  "function setUp(bytes initParams)",
  "function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "function scopeTarget(bytes32 roleKey, address targetAddress)",
  "function scopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)",
  "function setAllowance(bytes32 key, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
  "function allowances(bytes32 key) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)",
  "function execTransactionWithRole(address to, uint256 value, bytes data, uint8 operation, bytes32 roleKey, bool shouldRevert) returns (bool success)",
  "function isModuleEnabled(address module) view returns (bool)",
  "event AssignRoles(address module, bytes32[] roleKeys, bool[] memberOf)",
  "event ScopeTarget(bytes32 roleKey, address targetAddress)",
  "event ScopeFunction(bytes32 roleKey, address targetAddress, bytes4 selector, (uint8 parent, uint8 paramType, uint8 operator, bytes compValue)[] conditions, uint8 options)",
  "event AllowTarget(bytes32 roleKey, address targetAddress, uint8 options)",
  "event AllowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)",
  "event RevokeTarget(bytes32 roleKey, address targetAddress)",
  "event RevokeFunction(bytes32 roleKey, address targetAddress, bytes4 selector)",
  "event SetAllowance(bytes32 allowanceKey, uint128 balance, uint128 maxRefill, uint128 refill, uint64 period, uint64 timestamp)",
  "event ConsumeAllowance(bytes32 allowanceKey, uint128 consumed, uint128 newBalance)",
  "error NoMembership()",
  "error NotAuthorized(address unauthorized)",
  "error ConditionViolation(uint8 status, bytes32 info)",
  "error ModuleTransactionFailed()",
]);

export const moduleProxyFactoryAbi = parseAbi([
  "function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)",
]);

export const safeModuleAbi = parseAbi([
  "function enableModule(address module)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const aaveRepayAbi = parseAbi([
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
]);
