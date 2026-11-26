// Secret-shaped input (G2): the server never stores, or sends to the model, a recovery phrase or private key.
import { english } from "viem/accounts";

/** What the thread keeps in place of a message that looked like a secret. */
export const REDACTED_MESSAGE = "Message removed: it looked like a secret key or recovery phrase.";

const WORDS: ReadonlySet<string> = new Set(english);
const HEX_KEY = /(?<![0-9a-z])(?:0x)?[0-9a-f]{64}(?![0-9a-z])/i;
const EXTENDED_KEY = /\b[xyzt]prv[1-9A-HJ-NP-Za-km-z]{50,}/;
const MIN_WORDS = 12; // phrases are 12/15/18/21/24 words

/** True when 12 or more consecutive words are all BIP-39 words (a phrase with a stray word beside it still counts). */
function hasMnemonic(text: string): boolean {
  let run = 0;
  for (const t of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    run = WORDS.has(t) ? run + 1 : 0;
    if (run >= MIN_WORDS) return true;
  }
  return false;
}

/** True when the text looks like a BIP-39 phrase, a 32-byte hex private key, or an extended private key. */
export const looksLikeSecret = (text: string): boolean => HEX_KEY.test(text) || EXTENDED_KEY.test(text) || hasMnemonic(text);
