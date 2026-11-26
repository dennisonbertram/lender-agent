import { useEffect, useState } from "react";

/** True below 480 px (the action bar's phone layout). False on the server and first paint, so markup matches. */
export function usePhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const m = window.matchMedia?.("(max-width: 479px)");
    if (!m) return;
    setPhone(m.matches);
    const on = (e: MediaQueryListEvent) => setPhone(e.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}
