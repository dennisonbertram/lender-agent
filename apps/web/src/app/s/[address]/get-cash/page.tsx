"use client";
import { use } from "react";
import { GetCash } from "@/components/get-cash/GetCash";

export default function GetCashPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  return <GetCash address={address} />;
}
