"use client";
import { use } from "react";
import Link from "next/link";
import { ProposalReview } from "@/components/proposals/ProposalReview";
import { safePaths } from "@/components/shell/Sidebar";

// The Safe layout shows "You are not an owner of this Safe" for a non-owner; no proposal data is fetched then.
export default function ProposalPage({ params }: { params: Promise<{ address: string; id: string }> }) {
  const { address, id } = use(params);
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col">
      <Link href={safePaths(address).activity} className="mx-4 mt-4 inline-flex min-h-11 w-fit items-center text-sm underline underline-offset-2">← Back to Activity</Link>
      <ProposalReview safeAddress={address} id={id} acceptApproveIntent />
    </div>
  );
}
