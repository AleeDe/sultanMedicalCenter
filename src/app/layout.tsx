import type { Metadata, Viewport } from "next";
import { Nav } from "@/components/Nav";
import { RegisterSW } from "@/components/RegisterSW";
import { getSeries } from "@/app/actions/tokens";
import "./globals.css";

export const metadata: Metadata = {
  title: "Token & Billing",
  description: "OPD / Emergency token generation and billing",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Front-desk staff must be able to zoom; never disable it.
  maximumScale: 5,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /*
    The nav needs the active series so the offline chip can report how many
    reserved token numbers remain — that count is the real constraint during
    an outage, not the number of queued writes.

    Failing soft: if the database is unreachable at render time the nav still
    renders, which is exactly the situation the offline path exists for.
  */
  const series = await getSeries().catch(() => []);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <RegisterSW />
        <Nav seriesIds={series.map((s) => s.id)} />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
