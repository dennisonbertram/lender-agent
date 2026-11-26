import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = { title: "Privacy Policy | Lender agent", description: "How Lender agent handles information." };
export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  const email = process.env.PRIVACY_EMAIL;
  const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  return <LegalPage title="Privacy Policy" updated="November 26, 2026">
    <p>This policy explains how DappHero Corp. handles information when you use the hosted Lender agent service.</p>
    <LegalSection title="Information you provide or use in the Service">
      <ul>
        <li><strong>When you sign in:</strong> the Service receives your public wallet address, network, and signed sign-in message to verify your wallet. It creates a login session. The session cookie is HTTP-only and expires after seven days. The Service stores a one-way hash of its random token rather than the token itself.</li>
        <li><strong>When you add or create a Safe:</strong> the Service stores its public address and the name you provide, along with Safe setup, owner, network, and threshold information used to show and operate the Safe.</li>
        <li><strong>When you use loans and proposals:</strong> the Service stores proposal details, transaction and confirmation status, Safe activity, and loan monitoring snapshots so it can show and monitor your positions. Wallet signatures submitted to approve proposals are sent to the Safe transaction service; transactions submitted to a public blockchain can be seen by anyone.</li>
        <li><strong>When you use chat:</strong> the Service stores messages and replies in a shared conversation for that Safe. To answer a message, it sends Anthropic your new message, the Safe's shared chat history—which can include messages from other owners—and relevant current Safe, loan, and market information. When deposit monitoring detects a deposit on a supported Aave network, the Service may also ask Anthropic to generate a follow-up without a new chat message; that request can include the shared history and deposit context.</li>
        <li><strong>If you add an email address:</strong> the Service stores it for the email alerts and co-owner proposal notices you enable. If email delivery is configured, the address and message are sent to Resend. You can turn email off in Settings or use an unsubscribe link in an email.</li>
        <li><strong>Safe nicknames:</strong> if a browser-only nickname feature is available in Settings, the nickname stays in your browser and is not sent to the Service. A name you provide when adding or creating a Safe is different: it is stored with that Safe in the Service.</li>
        <li><strong>Browser storage:</strong> your browser keeps some setup progress, repayment intent, and display state in local storage, and a short-lived approval marker in session storage.</li>
      </ul>
    </LegalSection>
    <LegalSection title="Service providers">
      <p>The Service uses Anthropic for chat and Resend for email when email delivery is configured. If you request a cross-network quote, it sends the Safe address, source and destination networks, token addresses, and proposed amount to LI.FI, a third-party service that finds cross-network routes and returns fee and delivery estimates. This happens before an owner approves or submits the move; requesting a quote does not send a transaction. After a move is submitted, the Service may also ask LI.FI for its status using the transaction hash and network information. The Service also sends network requests to blockchain RPC providers and Safe transaction services to read or submit information about the wallet and transactions you use. Your wallet software may send information directly to wallet providers and blockchain networks when you connect or sign.</p>
    </LegalSection>
    <LegalSection title="Ads, tracking, and cookies">
      <p>The Lender agent website does not use advertising cookies or analytics trackers. It uses an essential login cookie to keep you signed in. Your browser and wallet provider may have their own storage and privacy practices.</p>
    </LegalSection>
    <LegalSection title="Public blockchain records">
      <p>Wallet addresses, signed transactions, and other information sent to a public blockchain are public and may remain there permanently. DappHero Corp. cannot remove or change those blockchain records. Using the Service does not make them private.</p>
    </LegalSection>
    <LegalSection title="Your choices">
      <p>You can sign out, turn off email alerts in Settings or use an email's unsubscribe link, and clear the Service's browser storage through your browser settings. Turning off emails stops future alert delivery from the Service; it does not withdraw emails already sent or remove public blockchain records.</p>
      {validEmail ? <p>For privacy questions about the hosted Service, email <a href={`mailto:${validEmail}`}>{validEmail}</a>.</p> : <p>No privacy email address is listed here. If DappHero Corp. has provided you a private contact channel, use it for privacy questions. Do not post personal information, wallet addresses, signatures, or account details in public forums or issue trackers.</p>}
      <p>For the terms that apply when you use the Service, read the <Link href="/terms">Terms of Service</Link>.</p>
    </LegalSection>
  </LegalPage>;
}
