"use client";

import { AddFundsBody } from "@/components/common";
import { blockCard } from "./card";

export const AddFundsBlock = ({ address, networks, assets }: { address: string; networks: string[]; assets?: string[] }) => (
  <div className={blockCard}><AddFundsBody address={address} networks={networks} assets={assets} /></div>
);
