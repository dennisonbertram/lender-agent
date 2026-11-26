"use client";
import { use } from "react";
import { ReserveView } from "@/components/reserve/ReserveView";

export default function ReservePage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  return <ReserveView address={address} />;
}
