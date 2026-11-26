import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, size, slice } from "viem";
import { MULTISEND_CALL_ONLY } from "./constants";
import { buildSafeTx, encodeMultiSend, encodeMultiSendTransactions, multiSendAbi } from "./multisend";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;

describe("multisend", () => {
  it("packs operation | to | value | length | data per call", () => {
    const packed = encodeMultiSendTransactions([
      { to: A, data: "0x095ea7b3" },
      { to: B, value: 5n },
    ]);
    // call 1: 1 + 20 + 32 + 32 + 4 = 89 bytes; call 2: 85 bytes
    expect(size(packed)).toBe(89 + 85);
    expect(slice(packed, 0, 1)).toBe("0x00");
    expect(slice(packed, 1, 21)).toBe(A);
    expect(BigInt(slice(packed, 21, 53))).toBe(0n);
    expect(BigInt(slice(packed, 53, 85))).toBe(4n);
    expect(slice(packed, 85, 89)).toBe("0x095ea7b3");
    expect(slice(packed, 89 + 1, 89 + 21)).toBe(B);
    expect(BigInt(slice(packed, 89 + 21, 89 + 53))).toBe(5n);
  });

  it("wraps in multiSend(bytes)", () => {
    const data = encodeMultiSend([{ to: A }, { to: B }]);
    const d = decodeFunctionData({ abi: multiSendAbi, data });
    expect(d.functionName).toBe("multiSend");
    expect(d.args[0]).toBe(encodeMultiSendTransactions([{ to: A }, { to: B }]));
  });

  it("rejects an inner delegate call", () => {
    expect(() => encodeMultiSendTransactions([{ to: A }, { to: B, operation: 1 }])).toThrow(/delegate call/);
    expect(() => buildSafeTx([{ to: A }, { to: B, operation: 1 }], 0)).toThrow(/delegate call/);
    expect(() => buildSafeTx([{ to: A, operation: 1 }], 0)).toThrow(/delegate call/);
  });

  it("outer tx: one call is plain, several go via MultiSendCallOnly with operation 1", () => {
    const one = buildSafeTx([{ to: A, data: "0x1234" }], 7);
    expect(one).toMatchObject({ to: getAddress(A), operation: 0, data: "0x1234", nonce: "7", value: "0" });
    const two = buildSafeTx([{ to: A }, { to: B }], 8n);
    expect(two).toMatchObject({ to: MULTISEND_CALL_ONLY, operation: 1, value: "0", nonce: "8" });
  });

  it("refuses an empty batch", () => {
    expect(() => buildSafeTx([], 0)).toThrow();
  });
});
