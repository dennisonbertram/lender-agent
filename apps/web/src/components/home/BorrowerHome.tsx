"use client";

import Image from "next/image";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { SignInCard } from "@/components/auth/SignInCard";
import styles from "./borrower-home.module.css";

const steps = [
  {
    number: "01",
    title: "Review a loan quote.",
    text: "See the interest, repayment details, and the price at which your collateral may be sold before you decide.",
  },
  {
    number: "02",
    title: "Approve with your Safe owners.",
    text: "The Safe owners approve the borrowing transaction. Borrowed USDC is sent to the Safe.",
  },
  {
    number: "03",
    title: "Repay according to lender terms.",
    text: "Some lenders allow partial repayment, while others require the loan to be repaid in full.",
  },
];

export function BorrowerHome() {
  return (
    <main className={styles.page}>
      <div className={styles.frame}>
        <header className={styles.header}>
          <a className={styles.wordmark} href="/" aria-label="Lender agent home">
            <span className={styles.mark} aria-hidden="true"><span /><span /><span /></span>
            <span>Lender<span className={styles.wordmarkLight}> agent</span></span>
          </a>
          <nav className={styles.nav} aria-label="Main navigation">
            <a href="#how-it-works">How it works <ArrowDownRight aria-hidden="true" /></a>
            <a className={styles.navAction} href="#get-started">Get started <ArrowUpRight aria-hidden="true" /></a>
          </nav>
        </header>

        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <h1 id="hero-title">Borrow against<br /><em>your crypto.</em></h1>
            <p className={styles.intro}>Receive digital dollars (USDC) in your Safe wallet, a shared crypto wallet whose owners approve transactions. See the estimated interest and when collateral may be sold before you approve. Moving dollars to a bank is a separate step.</p>
            <SignInCard presentation="hero" className={styles.signIn} id="get-started" />
          </div>
          <figure className={styles.heroArt}>
            <Image
              src="/images/borrower-still-life.webp"
              alt="Sculptural amber glass forms resting on a dark stone base"
              fill
              priority
              sizes="(max-width: 760px) 100vw, 50vw"
              className={styles.heroImage}
            />
          </figure>
        </section>

        <section className={styles.process} id="how-it-works" aria-labelledby="process-title">
          <div className={styles.processIntro}>
            <h2 id="process-title">How borrowing works</h2>
          </div>
          <ol className={styles.steps}>
            {steps.map((step) => (
              <li className={styles.step} key={step.number}>
                <span className={styles.stepNumber}>{step.number}</span>
                <div><h3>{step.title}</h3><p>{step.text}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <footer className={styles.footer}>
          <a className={styles.wordmark} href="/" aria-label="Lender agent home">
            <span className={styles.mark} aria-hidden="true"><span /><span /><span /></span>
            <span>Lender<span className={styles.wordmarkLight}> agent</span></span>
          </a>
          <nav aria-label="Legal">
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
          </nav>
        </footer>
      </div>
    </main>
  );
}
