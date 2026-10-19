"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { CallStatus, SettingsView } from "@ai-caller/shared";
import { api, SETTINGS_CHANGED } from "@/lib/api";
import { useMe } from "./AuthGate";

const LINKS = [
  ["/", "Calls"],
  ["/new/", "New call"],
  ["/playbooks/", "Playbooks"],
  ["/profile/", "Profile"],
  ["/settings/", "Settings"],
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  const me = useMe();
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    if (!me) return;
    const load = () =>
      api<SettingsView>("/settings")
        .then((s) => setConfigured(s.configured))
        .catch(() => undefined);
    void load();
    window.addEventListener(SETTINGS_CHANGED, load);
    return () => window.removeEventListener(SETTINGS_CHANGED, load);
  }, [me]);
  if (!me) return <main>{children}</main>;
  const links = me.isAdmin ? [...LINKS, ["/admin/", "Admin"] as const] : LINKS;
  const signOut = () => api("/auth/logout", "POST", {}).finally(() => location.replace("/login/"));
  return (
    <>
      <nav className="nav">
        <span className="brand">AI Caller</span>
        {links.map(([href, label]) => (
          <Link key={href} href={href} className={path === href || (href !== "/" && path.startsWith(href)) ? "active" : ""}>
            {label}
          </Link>
        ))}
        <span className="muted">{me.email}</span>
        <button className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </nav>
      <main>
        {!configured && path !== "/settings/" && (
          <div className="banner">
            First time here? <Link href="/settings/">Open Settings</Link> and choose a model and API key before your first call.
          </div>
        )}
        {children}
      </main>
    </>
  );
}

const LIVE = new Set<CallStatus>(["dialing", "navigating", "on_hold", "with_human"]);
export function StatusBadge({ status }: { status: CallStatus }) {
  const cls = LIVE.has(status)
    ? "live"
    : status === "awaiting_approval"
      ? "waiting"
      : status === "completed" || status === "transferred"
        ? "good"
        : status === "failed"
          ? "bad"
          : "";
  return <span className={`badge ${cls}`}>{status.replace("_", " ")}</span>;
}
