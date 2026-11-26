"use client";
/** "as of 14:32": every figure shows when it was read (BP-11). */
export const asOfTime = (readAt: number) => new Date(readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function AsOf({ readAt, blockNumber }: { readAt: number; blockNumber?: number }) {
  return (
    <p className="mt-1.5 text-xs text-muted-foreground" title={blockNumber ? `Block ${blockNumber}` : undefined}>as of {asOfTime(readAt)}</p>
  );
}

export const BlockLoading = () => <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
export const BlockError = ({ message }: { message: string }) => <p className="text-sm text-muted-foreground" role="alert">{message}</p>;
