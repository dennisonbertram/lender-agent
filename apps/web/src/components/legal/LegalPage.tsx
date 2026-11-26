import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./legal-page.module.css";

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="Lender agent home"><span className={styles.mark}>L</span><span>Lender agent</span></Link>
        <Link className={styles.home} href="/">Back to home <span aria-hidden="true">↗</span></Link>
      </div>
      <article className={styles.article}>
        <p className={styles.eyebrow}>LENDER AGENT · LEGAL</p>
        <h1>{title}</h1>
        <p className={styles.updated}>Last updated: {updated}</p>
        <div className={styles.content}>{children}</div>
      </article>
      <footer className={styles.footer}>
        <span>© DappHero Corp.</span>
        <nav aria-label="Legal"><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link></nav>
      </footer>
    </main>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return <section><h2>{title}</h2>{children}</section>;
}
