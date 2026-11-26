import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "Lender agent",
  description: "A clearer way to borrow against crypto with your Safe in control.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="dark">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
