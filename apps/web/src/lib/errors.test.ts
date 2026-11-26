import { describe, expect, it } from "vitest";
import { ApiError } from "@/client/http";
import { describeError } from "./errors";

describe("describeError", () => {
  it("maps each failure to a kind with plain words", () => {
    expect(describeError(new ApiError(401, "x"), "loan").kind).toBe("signed-out");
    expect(describeError(new ApiError(403, "x"), "loan").kind).toBe("no-access");
    const nf = describeError(new ApiError(404, "x"), "loan");
    expect(nf.title).toBe("We could not find this loan");
    expect(nf.reason).toBe("We could not find this loan. It may have been closed or repaid.");
    expect(nf.primary).toEqual({ label: "Activity", href: "/onboarding" });
    expect(nf.secondary).toMatchObject({ label: "Back to Overview" });
    expect(describeError(new ApiError(404, "x"), "loan", { backHref: "/s/0xa" }).primary).toEqual({ label: "Activity", href: "/s/0xa/activity" });
    expect(describeError(new TypeError("fetch failed"), "loans").kind).toBe("offline");
    expect(describeError(new ApiError(500, "x"), "reserve").kind).toBe("server");
  });
  it("keeps the agent-step strings", () => {
    expect(describeError(new ApiError(403, "x"), "safe").title).toBe("You are not an owner of this Safe");
    expect(describeError(new ApiError(404, "x"), "safe").title).toBe("We could not load this Safe");
  });
});
