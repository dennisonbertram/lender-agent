import { useEffect, useRef } from "react";
import { Menu, MessageSquare, X } from "lucide-react";
import { AppProvider, useApp, useAttention, useMedia } from "@/store";
import { HealthDot } from "@/components/common";
import { agentButtonLabel } from "@/lib/loan-copy";
import { Sidebar, SafePicker } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { Chat } from "@/components/Chat";
import { Onboarding } from "@/components/Onboarding";
import { LoanDashboard } from "@/components/LoanDashboard";
import { OfferExplorer } from "@/components/OfferExplorer";
import { GetCash } from "@/components/GetCash";
import { ActivityLog } from "@/components/ActivityLog";
import { Settings } from "@/components/Settings";
import { SafeHome } from "@/components/SafeHome";
import { AddSafeDialog } from "@/components/AddSafeDialog";
import { ReserveView } from "@/components/ReserveView";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";

function Shell() {
  const { view, safe, chatDocked, setChatDocked, chatSheet, setChatSheet, navSheet, setNavSheet } = useApp();
  const { risk } = useAttention();
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewId = "id" in view ? view.id : "";
  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [view.name, viewId]);
  const showSidebar = useMedia("(min-width: 768px)");
  const showChat = useMedia("(min-width: 1100px)");
  const onChat = view.name === "chat"; // the view is the chat: no side panel or header button
  const docked = showChat && chatDocked && !onChat && view.name !== "cash"; // Get cash is one plan, edited in place: no second plan beside it

  if (view.name === "onboarding") {
    return <div className="h-full overflow-y-auto"><Onboarding /></div>;
  }

  return (
    <div className="flex h-full overflow-hidden">
      {showSidebar && <aside className="w-[232px] shrink-0 border-r border-sidebar-border"><Sidebar /></aside>}

      <main className="flex min-w-0 flex-1 flex-col">
        {(!showSidebar || (!docked && !onChat)) && (
        <header className="flex items-center gap-2 border-b border-border p-2 pl-3">
          {!showSidebar && (
            <Button variant="ghost" size="icon" aria-label="Menu" onClick={() => setNavSheet(true)}><Menu /></Button>
          )}
          {!showSidebar && <SafePicker compact />}
          {!docked && !onChat && (
            <Button variant="outline" size="sm" className="ml-auto" aria-label={agentButtonLabel(risk)} onClick={() => { setChatDocked(true); setChatSheet(true); }}>
              <MessageSquare /> Lender agent {risk > 0 && <HealthDot s="risk" />}
            </Button>
          )}
        </header>
        )}
        {onChat ? <div className="min-h-0 flex-1"><ChatView key={safe.id} /></div> : (
        <div ref={scrollRef} className="rk-scroll min-h-0 flex-1 overflow-y-auto">
          {view.name === "cash" ? <GetCash key={safe.id} /> : (
            <div className="mx-auto w-full max-w-5xl">
              {view.name === "loan" && <LoanDashboard id={view.id} />}
              {view.name === "home" && <SafeHome />}
              {view.name === "offers" && <OfferExplorer key={safe.id} />}
              {view.name === "activity" && <ActivityLog />}
              {view.name === "settings" && <Settings />}
              {view.name === "reserve" && <ReserveView />}
            </div>
          )}
        </div>
        )}
      </main>

      {docked && (
        <aside className="w-[440px] min-[1440px]:w-[520px] shrink-0 border-l border-border"><Chat onClose={() => setChatDocked(false)} /></aside>
      )}

      <AddSafeDialog />

      {!showSidebar && (
        <Sheet open={navSheet} onOpenChange={setNavSheet}>
          <SheetContent className="h-[85dvh] p-0">
            <div className="flex items-center justify-between px-3 pt-3">
              <SheetTitle>Menu</SheetTitle>
              <SheetClose render={<Button variant="ghost" size="icon" className="size-11" aria-label="Close menu" />}><X /></SheetClose>
            </div>
            <Sidebar />
          </SheetContent>
        </Sheet>
      )}
      {(!showChat || view.name === "cash") && (
        <Sheet open={chatSheet && !onChat} onOpenChange={setChatSheet}>
          <SheetContent className="h-[90dvh] overflow-hidden p-0">
            <SheetTitle className="sr-only">Lender agent</SheetTitle>
            <Chat onClose={() => setChatSheet(false)} />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
