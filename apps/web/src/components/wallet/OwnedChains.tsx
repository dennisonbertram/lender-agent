"use client";

import { createContext, useContext } from "react";

/** Chain ids where the Safe in view is set up and owned by the signed-in user (from the server). Undefined outside the Safe layout. */
const OwnedChainsContext = createContext<readonly number[] | undefined>(undefined);

export const OwnedChainsProvider = OwnedChainsContext.Provider;
export const useOwnedChains = () => useContext(OwnedChainsContext);
