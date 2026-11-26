// Checks on the model's text (BP-10, eval A3/A2). Figures come from blocks, never from the model (G1).

/** The fixed reply used when the text fails a check: routeIntent's default sentence from the mockup (r14). */
export const SAFE_SENTENCE = "I can plan a loan, compare lenders, show what a price drop would do, or explain how this works.";

/** The fixed reply to a request to sign, send or execute. */
export const ONLY_SUGGEST_TEXT =
  "I only suggest. I can't sign, send or execute anything, and I never need a key or seed phrase. The owners of this Safe approve every transaction here in the app.";

const UNIT = "k|m|bn|usd|usdc|dai|eth|weth|wsteth|wbtc|btc|dollars?|bucks|bps|basis points?|gwei|percent|cents?";

const FINANCE = "health factor|rates?|apr|apy|fees?|prices?|costs?|liquidat\\w*|borrow\\w*|collateral|usd|usdc|eth|\\$|%";
const NUM = "\\d+(?:\\.\\d+)?";
const FINANCE_THEN_NUMBER = new RegExp(`(?:\\b|(?<=\\W))(?:${FINANCE})(?:\\b|(?<=[$%]))[^.\\n]{0,40}?\\b${NUM}\\b`, "i");
const NUMBER_THEN_FINANCE = new RegExp(`\\b${NUM}\\b[^.\\n]{0,40}?(?:\\b|(?<=\\W))(?:${FINANCE})(?:\\b|(?<=[$%]))`, "i");
const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const SMALL = "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const SPELLED = `(?:(?:${TENS})(?:[- ](?:one|${SMALL}))?|${SMALL}|half|quarter|double|triple|dozen)`;
const SPELLED_WITH_UNIT = new RegExp(`\\b(?:one|${SPELLED})[- ]?(?:${UNIT})\\b`, "i");
const BIG_SPELLED = /\b(?:a|one|two|three|four|five|six|seven|eight|nine|ten|several|few)?\s*(?:hundred|thousand|million|billion)\b/i;
const SPELLED_THEN_FINANCE = new RegExp(`\\b${SPELLED}\\b[^.\\n]{0,40}?(?:\\b|(?<=\\W))(?:${FINANCE})(?:\\b|(?<=[$%]))`, "i");
const FINANCE_THEN_SPELLED = new RegExp(`(?:\\b|(?<=\\W))(?:${FINANCE})(?:\\b|(?<=[$%]))[^.\\n]{0,40}?\\b${SPELLED}\\b`, "i");

// G1: no figure shown to a user comes from the model, so any digit or number word in model text is one.
const NUMBER_WORDS = new RegExp(`\\b(?:zero|one|${SMALL}|${TENS}|hundred|thousand|million|billion|half|quarter|dozen)\\b`, "i");
const ONE_PHRASES = /\b(?:one of|this one|no one|the one)\b/gi; // "one" as a pronoun
const FIXED_TEXTS = [SAFE_SENTENCE, ONLY_SUGGEST_TEXT]; // the app's own wording, allowed as written

/** True when the text states an amount, price, rate, fee, percentage or any other figure. */
export function textHasFigure(raw: string): boolean {
  let text = raw;
  for (const fixed of FIXED_TEXTS) text = text.split(fixed).join(" ");
  if (/(?<![A-Za-z])\d/.test(text)) return true; // any digit; "v3" is a name, not a figure
  if (NUMBER_WORDS.test(text.replace(ONE_PHRASES, " "))) return true;
  if (/[$€£]\s?\d/.test(text)) return true;
  if (/\d\s?%/.test(text)) return true;
  if (new RegExp(`\\d(?:[\\d,]*\\.?\\d*)\\s?(?:${UNIT})\\b`, "i").test(text)) return true;
  if (/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/.test(text)) return true; // 12,000
  if (/\b\d+\.\d+\b/.test(text)) return true; // 1.5, 4.25
  if (/\b\d{3,}\b/.test(text)) return true; // 5000
  if (/\b(?:apr|apy|rate|fee|price|cost)s?\b[^.\n]{0,40}\b\d/i.test(text)) return true;
  if (FINANCE_THEN_NUMBER.test(text) || NUMBER_THEN_FINANCE.test(text)) return true;
  if (SPELLED_WITH_UNIT.test(text) || BIG_SPELLED.test(text)) return true;
  if (SPELLED_THEN_FINANCE.test(text) || FINANCE_THEN_SPELLED.test(text)) return true;
  return false;
}

/** Keep only the chips that pass the same figure guard as the model's text (a chip renders verbatim). */
export const safeChips = (items: readonly string[]): string[] => items.filter((t) => !textProblem(t));

const ACTION = "signed|sent|executed|queued|submitted|broadcast|approved|transferred|moved|confirmed|proposed to your safe";
const FIRST_PERSON = new RegExp(`\\b(?:i|we)(?:'ve|\\s+have)?\\s+(?:just\\s+|already\\s+|now\\s+|successfully\\s+)?(?:${ACTION})\\b`, "i");
const PASSIVE = new RegExp(`\\b(?:it|that|this|transaction|loan|funds|money|proposal|payment)\\s*(?:'s|is|was|has been|have been|were)\\s+(?:now\\s+|already\\s+|successfully\\s+)?(?:${ACTION})\\b`, "i");
const WILL = /\bi(?:'ll|\s+will)\s+(?:sign|send|execute|submit|approve|transfer)\b/i;
const DONE = /\b(?:done|all set)[.!,]\s*(?:i|it|your)\b/i;

/** True when the text claims the agent signed, sent, executed or queued something for the main Safe. */
export const claimsAction = (text: string): boolean => FIRST_PERSON.test(text) || PASSIVE.test(text) || WILL.test(text) || DONE.test(text);

const KEY_NOUN = "seed phrase|private key|recovery phrase|secret phrase|mnemonic|secret key|passphrase";
const ASK = new RegExp(`\\b(?:share|send|paste|enter|give|provide|tell|type|show|upload|dm|post)\\b[^.\\n]{0,40}\\byour\\s+(?:${KEY_NOUN})`, "i");
const ASK2 = new RegExp(`\\b(?:what(?:'s| is)|need|require|require|please)\\b[^.\\n]{0,20}\\byour\\s+(?:${KEY_NOUN})`, "i");
const ACCEPT = new RegExp(`\\b(?:thanks for|received|got|i have|using)\\s+your\\s+(?:${KEY_NOUN})`, "i");

/** True when the text asks for, or says it accepted, a key or seed phrase. */
export const asksForKey = (text: string): boolean => ASK.test(text) || ASK2.test(text) || ACCEPT.test(text);

/** Why a text fails the server guard, or null when it passes. */
export function textProblem(text: string): "figure" | "action" | "key" | null {
  if (textHasFigure(text)) return "figure";
  if (claimsAction(text)) return "action";
  if (asksForKey(text)) return "key";
  return null;
}

/** A request to sign, send, execute, skip the owners, or hand over a key (eval A2). */
const POWER_REQUEST = /\b(just send|send it|sign (it|this|that|for me)|execute|co-?signer is asleep|skip (the )?(owners?|signatures?)|seed phrase|private key|recovery phrase|mnemonic|secret phrase)\b|\b(move|send|transfer|withdraw)\b[^.?!]*\b0x[0-9a-f]{3,}/i;
export const isPowerRequest = (text: string): boolean => POWER_REQUEST.test(text);

const RETRACTION = /shouldn'?t have (?:quoted|given|stated|shared|written)|(?:can'?t|cannot) vouch|(?:need|have|want) to (?:correct|retract|take back)|\bcorrect(?:ion)?\b[^.\n]{0,30}\b(?:last|previous|earlier) (?:message|reply)|\bwrongly (?:said|stated|claimed)|\bmy (?:last|previous|earlier) (?:message|reply)[^.\n]{0,40}\b(?:wrong|mistake|error|incorrect)|\bI (?:apologi[sz]e|was wrong|made a mistake)/i;
/** A denial that the verified existing loan is open or funded (not one about a new proposal or plan: "that second loan is not funded" is true). The app posts that fact itself (done line, alerts), so with an open loan the model never says it. */
const LOAN_DENIAL = /\b(?:nothing|no loan)\s+(?:is|was|has been)\s+(?:open|funded|opened)|\bno loan (?:is |was )?(?:open|funded)|\byou (?:have|had) no (?:open )?loans?\b|\b(?:your|the) (?:existing |current )?loan (?:is not|isn'?t|was not|wasn'?t) (?:open|funded)|\bwrongly said a loan/i;

/** The model sometimes apologises for "figures" in its last message. Keep that only when the agent's own last text really had figures; cards and the user's numbers do not count. */
export function dropFalseRetraction(text: string, priorAgentText: string, hasLoan = false): string {
  const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const retract = !textHasFigure(priorAgentText);
  return parts.filter((p) => !(retract && RETRACTION.test(p)) && !(hasLoan && LOAN_DENIAL.test(p))).join("").trim();
}
