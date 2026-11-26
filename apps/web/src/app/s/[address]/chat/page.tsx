"use client";
import { use } from "react";
import { ChatView } from "@/components/chat/ChatView";

export default function ChatPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  return <ChatView address={address} />;
}
