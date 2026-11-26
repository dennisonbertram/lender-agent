import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

export const metadata: Metadata = { title: "Terms of Service | Lender agent", description: "Terms for using Lender agent." };

export default function TermsPage() {
  return <LegalPage title="Terms of Service" updated="November 26, 2026">
    <p>These terms govern your use of Lender agent and its website, software, and related features (the “Service”) when provided by DappHero Corp. By using the Service, you agree to these terms. If you do not agree, do not use it.</p>
    <LegalSection title="Before you use Lender agent">
      <p><strong>Use the Service at your own risk. You make your own choices about loans and transactions, and you are responsible for the risks and losses they may cause.</strong> Borrowing can put your collateral at risk of liquidation. The Service is provided “as is” and “as available.” It does not guarantee that information, data, warnings, or monitoring are accurate, complete, timely, or available, or that the Service, collateral, fees, third-party protocols, wallets, networks, or transactions will work as expected. These limits apply only to the extent the law allows; they do not remove rights or protections that the law requires.</p>
    </LegalSection>
    <LegalSection title="What the Service does">
      <p>Lender agent provides software for viewing information about supported crypto wallets and loans, asking an AI assistant questions, preparing transaction proposals, and monitoring supported positions. Features, networks, lenders, and data sources can change or become unavailable.</p>
      <p>The Service provides software and information only. It is not a bank, lender, broker, investment adviser, fiduciary, or party to any loan or blockchain transaction. Nothing it displays or generates is financial, investment, tax, or legal advice, a loan offer, or a recommendation that a transaction is suitable for you. AI output and market, protocol, wallet, and monitoring data can be incomplete, delayed, or wrong. Verify important details independently.</p>
    </LegalSection>
    <LegalSection title="Your decisions and transactions">
      <p>You are responsible for your decisions and for the loans and transactions you choose to make, including deciding whether to borrow, selecting the lender, assets, network, amount, and timing, reviewing transaction details, obtaining advice you consider appropriate, and managing repayment and collateral. You are responsible for losses, fees, liquidation, missed alerts, and other consequences of your choices, to the extent permitted by law.</p>
      <p>Wallets, Safe owners, smart contracts, lenders, bridges, blockchain networks, and other third parties operate independently. You must check the exact action and its destination in your wallet and Safe before approving it. A proposal or display is not a transaction guarantee. On-chain transactions may be irreversible, and network fees may be charged whether or not an action has the result you expect.</p>
      <p>Ordinary transactions require the approvals and signatures requested by your wallet or Safe owners. If you separately enable the optional Reserve feature, you may authorize a limited on-chain permission for automatic reserve actions under the limits you approve. That permission is distinct from ordinary proposal review: while it remains active, an action within its on-chain scope may execute without a new owner signature for each use. Read the displayed scope and limits, confirm the permission on-chain, and revoke it through the Safe when you no longer want it. The Service may stop its own use of a permission before the on-chain permission is removed.</p>
      <p>Monitoring and alerts are informational aids. Checks or messages can be delayed, unavailable, or fail to arrive. Do not rely on them as your only way to protect a position or meet a deadline.</p>
    </LegalSection>
    <LegalSection title="No guarantees; limits of responsibility">
      <p>To the extent permitted by law, the Service is provided without warranties or conditions of any kind, whether express, implied, or statutory. DappHero Corp. does not guarantee that the Service will be uninterrupted, secure, error-free, accurate, current, or available; that data, alerts, or monitoring will be complete or timely; or that any transaction, loan, collateral, fee estimate, smart contract, protocol, wallet, or third-party service will perform as expected. This section does not limit any right or protection that cannot lawfully be limited.</p>
      <p>To the extent permitted by law, DappHero Corp. is not responsible for indirect, incidental, special, consequential, exemplary, or punitive loss, lost profits, lost data, or loss of digital assets arising from or related to your use of the Service, third-party services, protocol or network behavior, or transactions you authorize. Nothing in these terms excludes or limits liability that cannot lawfully be excluded or limited, or any mandatory rights you have under applicable law.</p>
    </LegalSection>
    <LegalSection title="Acceptable use and access">
      <p>Use the Service only where lawful and in a way that does not interfere with its operation, compromise another person’s wallet or account, or attempt to bypass its security controls. You are responsible for the security of your wallet, signing devices, and credentials. We may change, suspend, or discontinue features or access when reasonably needed to operate or protect the Service, subject to rights that cannot be limited by law.</p>
    </LegalSection>
    <LegalSection title="Open-source software">
      <p>Some source code may be made available under a separate open-source license, including the MIT License where stated. That license governs your rights in the covered code. These Service terms do not replace or restrict rights granted by an applicable open-source license. Use of the hosted Service remains subject to these terms.</p>
    </LegalSection>
    <LegalSection title="Changes and contact">
      <p>DappHero Corp. may update these terms as the Service changes. The “Last updated” date identifies the current version. Your continued use after updated terms are posted means you accept them only to the extent applicable law permits that result.</p>
      <p>Do not post personal, wallet, or account information in public forums.</p>
    </LegalSection>
    <p>See the <Link href="/privacy">Privacy Policy</Link> for information about data handled by the Service.</p>
  </LegalPage>;
}
