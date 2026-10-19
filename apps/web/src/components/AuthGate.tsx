"use client";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Me } from "@ai-caller/shared";
import { api } from "@/lib/api";

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

/** Shows the app only to signed-in users; everyone else is sent to /login/. The login pages render without it. */
export function AuthGate({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  const isLogin = path.startsWith("/login");
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isLogin) return;
    const toLogin = () => location.replace("/login/");
    api<Me>("/me").then(setMe, (e: Error) => (e.message === "Unauthorized" ? toLogin() : setError(e.message)));
    window.addEventListener("aicaller-unauthorized", toLogin);
    return () => window.removeEventListener("aicaller-unauthorized", toLogin);
  }, [isLogin]);

  if (isLogin) return <>{children}</>;
  if (error) return <main className="error">Could not reach AI Caller: {error}</main>;
  if (!me) return <main className="muted">Loading…</main>;
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}
