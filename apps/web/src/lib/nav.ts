import type { View } from "@/lib/types";

/** Where to land after switching Safes: Ask the agent. Onboarding stays put. */
export const nextViewOnSwitch = (view: View): View => (view.name === "onboarding" ? view : { name: "chat" });
