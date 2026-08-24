import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Nav } from "@/components/Nav";
import { RegisterSW } from "@/components/RegisterSW";
import { ThemeScript } from "@/components/ThemeToggle";
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
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Sets data-theme before first paint, so a dark device never
            flashes white on load. */}
        <ThemeScript />
      </head>
      <body className="flex min-h-full flex-col">
        <RegisterSW />
        {/*
          The nav renders immediately; its series list streams in behind a
          Suspense boundary.

          Awaiting that query in the layout blocked the ENTIRE document —
          <head> included — on a database round trip, on every route. With
          the database in another region that delay was paid before the
          browser received a single byte, and if the database was unreachable
          the whole site simply hung. The list only feeds the offline status
          chip, which is not worth blocking a page load for.
        */}
        <Suspense fallback={<Nav />}>
          <NavWithSeries />
        </Suspense>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}

/**
 * Supplies the nav with the active series, out of band.
 *
 * Kept separate so a slow or failing query delays only the offline chip
 * rather than the document. Failing soft is deliberate: if the database is
 * unreachable the nav still renders, which is precisely the situation the
 * offline path exists to survive.
 */
async function NavWithSeries() {
  const series = await getSeries().catch(() => []);
  return <Nav seriesIds={series.map((s) => s.id)} />;
}
