"use client";
import { use } from "react";
import { LoanDashboard } from "@/components/loans/LoanDashboard";

export default function LoanPage({ params }: { params: Promise<{ address: string; loanId: string }> }) {
  const { address, loanId } = use(params);
  return <LoanDashboard address={address} loanId={decodeURIComponent(loanId)} />;
}
