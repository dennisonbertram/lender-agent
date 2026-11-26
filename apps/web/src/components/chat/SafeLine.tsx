"use client";
// One line under the agent's name: which Safe this chat is about, on which network (copy, explorer, Open in Safe).
import { SafeIdentity } from "@/components/ui/safe-identity";
import { useShell } from "@/components/shell/ShellContext";

export function SafeLine() {
  const { safe } = useShell();
  return <SafeIdentity safe={safe} />;
}
