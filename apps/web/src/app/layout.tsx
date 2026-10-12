import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { TokenGate } from "@/components/TokenGate";
import "./globals.css";

export const metadata: Metadata = { title: "AI Caller" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TokenGate>
          <Shell>{children}</Shell>
        </TokenGate>
      </body>
    </html>
  );
}
