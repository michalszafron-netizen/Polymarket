import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KRONOS TERMINAL // Polymarket Research",
  description:
    "Kronos-powered prediction market research terminal — live signals, equity curves, backtesting",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
