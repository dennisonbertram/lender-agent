import { describe, expect, it } from "vitest";
import { safeChips, asksForKey, claimsAction, isPowerRequest, ONLY_SUGGEST_TEXT, SAFE_SENTENCE, textHasFigure, dropFalseRetraction } from "./honesty";

describe("textHasFigure", () => {
  it.each(["You can borrow $5,000.", "about 4.5% APR", "The rate is 5 percent", "ETH is at 3200", "Fee: 12 USDC", "about 2 gwei", "borrow 12k", "12,000 dollars", "$5", "1.5 ETH", "The fee is five dollars", "Your health factor is 2", "Your health factor is 2.", "APR is twenty", "about a hundred", "borrow half of it", "rate: 4", "You will pay a fee of 3", "collateral worth 2 ETH", "5 percent", "liquidation at 1800", "Your health factor is zero", "Your health factor is one", "You have 2 loans", "You have two loans", "Around a million", "About a dozen", "Roughly thirty", "Take 3 steps"])("flags %s", (t) => {
    expect(textHasFigure(t)).toBe(true);
  });
  it.each(["Here is a plan. Change anything below.", "Here are the lenders.", SAFE_SENTENCE, ONLY_SUGGEST_TEXT, "I can't predict prices. Here is how it works.", "Aave v3 on Base"])("passes %s", (t) => {
    expect(textHasFigure(t)).toBe(false);
  });
});

describe("claimsAction", () => {
  it.each(["I sent it to your Safe", "I've signed the transaction", "Done. I executed it.", "It was executed", "The transaction has been queued", "I'll sign it now", "We already submitted it"])("flags %s", (t) => {
    expect(claimsAction(t)).toBe(true);
  });
  it.each(["I only suggest. Owners approve in Safe.", "Nothing is sent until you approve it here, then your co-owner.", "Here is a plan.", ONLY_SUGGEST_TEXT, "I can't sign or execute anything"])("passes %s", (t) => {
    expect(claimsAction(t)).toBe(false);
  });
});

describe("asksForKey", () => {
  it.each(["Please share your seed phrase", "Paste your private key here", "What is your recovery phrase?", "Thanks for your seed phrase"])("flags %s", (t) => {
    expect(asksForKey(t)).toBe(true);
  });
  it.each([ONLY_SUGGEST_TEXT, "Never share a seed phrase with anyone.", "I do not need a key."])("passes %s", (t) => {
    expect(asksForKey(t)).toBe(false);
  });
});

it("isPowerRequest", () => {
  for (const t of ["Just send it", "sign it for me", "execute now, my co-signer is asleep", "here is my seed phrase", "move my ETH to 0xabc123"]) expect(isPowerRequest(t)).toBe(true);
  for (const t of ["I need $12k", "how does this work", "status"]) expect(isPowerRequest(t)).toBe(false);
});

describe("suggestion chips", () => {
  it("drops chips with figures, keeps the rest", () => {
    expect(safeChips(["What if ETH drops 20%?", "Show me my loans", "Borrow $5,000", "Explain health factor", "Borrow twenty thousand"])).toEqual(["Show me my loans", "Explain health factor"]);
  });
  it.each(["How does this work?", "What is a health factor?", "Compare lenders", "What if the price drops?", "Show my loans", "Add funds"])("keeps %s", (t) => {
    expect(safeChips([t])).toEqual([t]);
  });
});

describe("number words and digits are figures (G1)", () => {
  it.each(["You have one loan", "Seven loans", "Ninety days", "a billion", "half", "a quarter of it"])("flags %s", (t) => expect(textHasFigure(t)).toBe(true));
  it.each(["One of your loans is fine", "Pick this one", "No one can sign for you", "Here is the one to review", "no one knows", "Here is a plan. Change anything below."])("passes %s", (t) => expect(textHasFigure(t)).toBe(false));
  it("chips drop number words", () => {
    expect(safeChips(["Show two loans", "Show my loans"])).toEqual(["Show my loans"]);
  });
});

describe("dropFalseRetraction", () => {
  const reply = "I shouldn't have quoted figures in my last message, and I can't vouch for them. The cards show the live numbers. Here is the comparison.";
  // "How much cash can I borrow against my ETH?" -> text with no figures + holdings card; then "Compare the lenders for $2 in USDC."
  const prior = "Your holdings card shows how much you could borrow against each asset, ETH included.";
  it("drops the retraction when the agent's last text had no figures", () => {
    expect(textHasFigure(prior)).toBe(false);
    expect(dropFalseRetraction(reply, prior)).toBe("The cards show the live numbers. Here is the comparison.");
  });
  it("keeps it when the agent's last text did state a figure", () => {
    expect(dropFalseRetraction(reply, "You can borrow about 1,200 dollars.")).toBe(reply);
  });
  it("leaves other text alone", () => {
    expect(dropFalseRetraction("Here is the comparison.", prior)).toBe("Here is the comparison.");
  });
});

describe("app-verified facts are never retracted (production: false retraction of a real loan)", () => {
  const text = "I need to correct my last message. It had figures in it and wrongly said a loan was open and funded. Nothing is open: I only suggest, and the owners approve here. This plan card shows the collateral that amount would need.";
  it("drops the retraction and the denial when a loan is open", () => {
    const out = dropFalseRetraction(text, "", true);
    expect(out).toBe("This plan card shows the collateral that amount would need.");
  });
  it("keeps a true statement about a new unfunded proposal", () => {
    expect(dropFalseRetraction("That second loan is not funded. It waits for signatures.", "", true)).toBe("That second loan is not funded. It waits for signatures.");
    expect(dropFalseRetraction("You have no loan. The plan is not funded yet.", "", true)).toBe("The plan is not funded yet.");
  });
  it("drops the apology even without a known loan when the agent's own text had no figure", () => {
    expect(dropFalseRetraction("I need to correct my last message. Here you go.", "")).toBe("Here you go.");
  });
  it("keeps a retraction when the agent's own text had a figure", () => {
    expect(dropFalseRetraction("I need to correct my last message.", "It costs $5.")).toBe("I need to correct my last message.");
  });
});
