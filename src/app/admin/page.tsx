import { headers } from "next/headers";
import { guardAdminPage } from "@/lib/auth";
import { AdminGate } from "@/components/AdminGate";
import { AdminScreen } from "@/components/AdminScreen";
import {
  getAllDoctors,
  getAllSeries,
  getAllServices,
} from "@/app/actions/admin";
import { getAnalytics } from "@/app/actions/analytics";
import { getClinic, getStaff } from "@/app/actions/tokens";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Must be signed in at all (redirects to login if not); the ADMIN role is a
  // second step, taken via the PIN below.
  const session = await guardAdminPage();

  /*
    The settings data is admin-gated on the server, so it is fetched only once
    the session actually holds the ADMIN role. A reception user reaching this
    route sees the admin PIN prompt with no data behind it — the elevation
    happens in AdminGate, which refreshes the page, and this fetch then runs.
    This ordering is what stops the page throwing before the gate can render.
  */
  if (session.role !== "ADMIN") {
    return <AdminGate />;
  }

  const [series, services, clinic, staff, doctors, analytics, h] =
    await Promise.all([
      getAllSeries(),
      getAllServices(),
      getClinic(),
      getStaff(),
      getAllDoctors(),
      getAnalytics(30),
      headers(),
    ]);

  // The printer-setup shortcut has to point back at this exact deployment,
  // so the URL is read from the request rather than hard-coded.
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const appUrl = `${proto}://${host}`;

  return (
    <AdminScreen
      series={series}
      services={services}
      clinic={clinic}
      staff={staff}
      doctors={doctors}
      analytics={analytics}
      appUrl={appUrl}
    />
  );
}
