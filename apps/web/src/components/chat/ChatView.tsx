"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/client/safes";
import { PROPOSAL_SENT_EVENT } from "@/client/proposals";
import { AgentWatchStatus } from "@/components/agent/AgentWatchStatus";
import { AgentOffNotice } from "@/components/agent/AgentOffNotice";
import { SafeLine } from "@/components/chat/SafeLine";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/chat/Composer";
import type { ProposalPlacement } from "@/components/chat/ProposalCardSlot";
import { MessageList } from "@/components/chat/MessageList";
import { GuideIntro } from "@/components/guide/Guide";
import { ReserveStatusChip } from "@/components/common";
import { useShell } from "@/components/shell/ShellContext";
import type { UIBlock } from "@/lib/blocks";

/** The live status line under the agent's name (r14): "Watching" only while the worker is healthy. */
export function AgentStatus() {
  const { reserve } = useShell();
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <AgentWatchStatus />
      {reserve && <ReserveStatusChip s={reserve} text={reserve.kind === "armed" ? "Can use reserve" : `Reserve ${reserve.label.toLowerCase()}`} />}
    </div>
  );
}

async function fetchThread(address: string): Promise<UIMessage[]> {
  const res = await fetch(`/api/safes/${address}/chat`);
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? "Something went wrong");
  return (await res.json()).messages;
}

const THREAD_POLL_MS = 15_000;
/** Dispatched on `window` after a Send to Safe succeeds: the chat then reloads the thread once. */
export { PROPOSAL_SENT_EVENT };

function Session({ address, initial, placeholder, placement, contextualHelpOnly, onForbidden }: { address: string; initial: UIMessage[]; placeholder: string; placement?: ProposalPlacement; contextualHelpOnly?: boolean; onForbidden: () => void }) {
  const shell = useShell();
  // The agent was just added from the notice below: the layout's flag is stale until the next load.
  const [justAdded, setJustAdded] = useState(false);
  const agentOn = shell.agentOn || justAdded;
  const transport = useMemo(
    () => new DefaultChatTransport({ api: `/api/safes/${address}/chat`, prepareSendMessagesRequest: ({ messages }) => ({ body: { messages: messages.slice(-1) } }) }),
    [address],
  );
  const { messages, sendMessage, setMessages, status, error } = useChat({ id: address.toLowerCase(), messages: initial, transport });
  const busy = status === "submitted" || status === "streaming";
  const [localFollowVersion, setLocalFollowVersion] = useState(0);
  const send = (text: string) => {
    if (busy) return;
    setLocalFollowVersion((n) => n + 1);
    void sendMessage({ text });
  };
  // A block the page posts itself (compare "Use"): a new agent message in this thread, shown like a tool result.
  const postBlock = useCallback((block: UIBlock) => {
    setLocalFollowVersion((n) => n + 1);
    setMessages((cur) => [...cur, { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "data-block", data: { block } }] }]);
  }, [setMessages]);
  // Server-pushed messages (deposit notes, alerts, the proposal card, Done) arrive without a reload.
  // The API has no `?after=` yet, so each poll fetches the whole thread and diffs client-side by id
  // (append in stored order; never rewrite or drop what the client has). Only while idle.
  const [notice, setNotice] = useState("");
  const forbiddenRef = useRef(false);
  const aliveRef = useRef(true);
  const activeAddressRef = useRef(address);
  activeAddressRef.current = address;
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const statusRef = useRef(status);
  statusRef.current = status;
  const pull = useCallback(async () => {
    if (forbiddenRef.current) return;
    try {
      const stored = await fetchThread(address);
      if (!aliveRef.current || activeAddressRef.current !== address || forbiddenRef.current || statusRef.current !== "ready" && statusRef.current !== "error") return; // ignore stale Safe/unmounted results; a reply started meanwhile will merge on the next poll
      let added = 0;
      setMessages((cur) => {
        const have = new Set(cur.map((m) => m.id));
        const fresh = stored.filter((m) => !have.has(m.id));
        added = fresh.length;
        return fresh.length ? [...cur, ...fresh] : cur;
      });
      if (added) setNotice((n) => (n === "New message from Lender agent" ? "New message from Lender agent." : "New message from Lender agent"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && aliveRef.current && activeAddressRef.current === address) {
        forbiddenRef.current = true;
        setMessages([]);
        onForbidden();
      }
      // Transient failures leave the open thread in place; the next poll tries again.
    }
  }, [address, onForbidden, setMessages]);
  const idle = status === "ready" || status === "error";
  useEffect(() => {
    if (!idle) return;
    const visible = () => document.visibilityState !== "hidden";
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => { if (!timer) timer = setInterval(() => void pull(), THREAD_POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
    const onVisibility = () => { if (visible()) { void pull(); start(); } else stop(); };
    const onFocus = () => { if (visible()) void pull(); };
    if (visible()) start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("focus", onFocus); };
  }, [pull, idle]);
  useEffect(() => {
    const onSent = () => void pull();
    window.addEventListener(PROPOSAL_SENT_EVENT, onSent);
    return () => window.removeEventListener(PROPOSAL_SENT_EVENT, onSent);
  }, [pull]);
  return (
    <>
      <MessageList messages={messages} safeAddress={address} onSend={send} typing={status === "submitted"} disabled={busy || !agentOn} onPostBlock={postBlock} placement={placement} contextualHelpOnly={contextualHelpOnly} localFollowVersion={localFollowVersion} />
      <div aria-live="polite" className="sr-only">{notice}</div>
      {error && <p role="alert" className="px-3 pb-1 text-xs text-muted-foreground">I could not answer just now. Try again.</p>}
      {agentOn ? <div className="shrink-0 border-t border-border bg-background p-3"><Composer placeholder={placeholder} disabled={busy} guideTarget onSend={send} /></div> : <AgentOffNotice safeAddress={address} onAdded={() => setJustAdded(true)} />}
    </>
  );
}

/** The message list and composer for one Safe: loads the stored thread, then chats. Shared by the page and the docked panel. */
export function ChatBody({ address, placeholder, placement, contextualHelpOnly }: { address: string; placeholder: string; placement?: ProposalPlacement; contextualHelpOnly?: boolean }) {
  const { agentOn } = useShell();
  const queryClient = useQueryClient();
  const [deniedAddress, setDeniedAddress] = useState<string | null>(null);
  const [checkingAddress, setCheckingAddress] = useState<string | null>(null);
  const [checkFailedAddress, setCheckFailedAddress] = useState<string | null>(null);
  const activeAddressRef = useRef(address);
  activeAddressRef.current = address;
  const queryKey = ["chat", address.toLowerCase()];
  const onForbidden = useCallback(() => {
    setDeniedAddress(address);
    queryClient.removeQueries({ queryKey: ["chat", address.toLowerCase()], exact: true });
  }, [address, queryClient]);
  const checkAccess = useCallback(async () => {
    setDeniedAddress(address);
    setCheckingAddress(address);
    setCheckFailedAddress(null);
    try {
      await queryClient.fetchQuery({ queryKey: ["chat", address.toLowerCase()], queryFn: () => fetchThread(address), staleTime: 0 });
      if (activeAddressRef.current === address) {
        setDeniedAddress((current) => current === address ? null : current);
        setCheckFailedAddress((current) => current === address ? null : current);
      }
    } catch {
      if (activeAddressRef.current === address) setCheckFailedAddress(address);
    } finally {
      setCheckingAddress((current) => current === address ? null : current);
    }
  }, [address, queryClient]);
  const thread = useQuery({ queryKey, queryFn: () => fetchThread(address), staleTime: Infinity, gcTime: 0, retry: false });
  const initialForbidden = thread.isError && thread.error instanceof ApiError && thread.error.status === 403;
  if (deniedAddress === address || initialForbidden) return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
      <p role="alert" className="text-sm text-muted-foreground">You need to be an owner of this Safe on every network to chat.</p>
      {checkFailedAddress === address && <p role="status" className="text-xs text-muted-foreground">We could not confirm access. Chat stays hidden until an authorized check succeeds.</p>}
      <Button size="sm" variant="outline" disabled={checkingAddress === address} onClick={() => void checkAccess()}>{checkingAddress === address ? "Checking access…" : "Check access again"}</Button>
    </div>
  );
  if (thread.isPending) {
    return (
      <>
        <div role="status" aria-label="Loading the conversation" className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden p-3">
          <div className="h-4 w-4/5 shrink-0 animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/5 shrink-0 animate-pulse rounded bg-muted" />
          <div className="h-8 w-2/5 shrink-0 animate-pulse rounded-full bg-muted" />
        </div>
        {agentOn && <div className="shrink-0 border-t border-border bg-background p-3"><Composer placeholder={placeholder} disabled lockInput onSend={() => {}} /></div>}
      </>
    );
  }
  if (thread.isError) {
    return (
      <>
        <div className="flex min-h-0 flex-1 items-center justify-center p-3"><div className="flex flex-col items-center gap-2 text-center"><p role="alert" className="text-sm text-muted-foreground">We could not load the conversation.</p><Button size="sm" variant="outline" onClick={() => void thread.refetch()}>Try again</Button></div></div>
        {agentOn ? <div className="shrink-0 border-t border-border bg-background p-3"><Composer placeholder={placeholder} disabled lockInput onSend={() => {}} /></div> : <AgentOffNotice safeAddress={address} />}
      </>
    );
  }
  return <Session address={address} initial={thread.data} placeholder={placeholder} placement={placement} contextualHelpOnly={contextualHelpOnly} onForbidden={onForbidden} />;
}

/** Ask the agent: the full-screen chat page. */
export function ChatView({ address }: { address: string }) {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col">
      <div className="flex items-center gap-3 border-b border-border p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background"><Bot className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">Lender agent</h1>
          <AgentStatus />
          <SafeLine />
        </div>
      </div>
      <GuideIntro topicId="chat" />
      <ChatBody address={address} placeholder="Ask anything, or say how much you need" />
    </div>
  );
}
