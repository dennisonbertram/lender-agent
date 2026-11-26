"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type Action = { label: string; href: string } | { label: string; onClick: () => void };

const REASSURE = "Nothing on your Safe has changed.";
const btn = "[@media(pointer:coarse)]:min-h-11";

/** True once `ms` have passed, so a fast load never flashes a spinner. */
function useDelayedFlag(ms: number) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return on;
}

function ActionButton({ action, outline }: { action: Action; outline?: boolean }) {
  const className = cn(buttonVariants(outline ? { variant: "outline" } : undefined), btn);
  return "href" in action
    ? <Link href={action.href} className={className}>{action.label}</Link>
    : <button type="button" className={className} onClick={action.onClick}>{action.label}</button>;
}

export type StateMessageProps =
  | { kind: "error"; title: string; reason: string; action: Action; secondary?: Action; reassure?: boolean; className?: string }
  | { kind: "loading"; label: string; className?: string };

/** One look for "this could not load" and "this is loading": an alert card with a way out, or a delayed spinner. */
export function StateMessage(props: StateMessageProps) {
  if (props.kind === "loading") return <Loading label={props.label} className={props.className} />;
  const { title, action, secondary, className } = props;
  // "We could not find …" may mean the thing was closed or repaid, so "nothing has changed" would be untrue there.
  const notFound = /^We could not find\b/.test(title);
  const reassure = props.reassure ?? !notFound;
  const reason = notFound && !props.reassure ? props.reason.replace(REASSURE, "").trim() : props.reason;
  return (
    <Card role="alert" className={cn("w-full max-w-md", className)}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>{title}</CardTitle>
        <CardDescription>{reassure && !reason.includes(REASSURE) ? `${reason} ${REASSURE}` : reason}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <ActionButton action={action} />
        {secondary && <ActionButton action={secondary} outline />}
      </CardContent>
    </Card>
  );
}

function Loading({ label, className }: { label: string; className?: string }) {
  const show = useDelayedFlag(1000);
  if (!show) return null;
  return (
    <div role="status" className={cn("flex items-center gap-2 py-6 text-sm text-muted-foreground", className)}>
      <Spinner aria-hidden role="presentation" />
      <span>{label}</span>
    </div>
  );
}
