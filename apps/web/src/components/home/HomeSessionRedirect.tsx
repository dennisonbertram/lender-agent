"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/client/auth/useSession";

export function HomeSessionRedirect({ returnTo }: { returnTo: string | null }) {
  const { session } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (session) router.replace(returnTo ?? "/onboarding");
  }, [returnTo, router, session]);

  return null;
}
