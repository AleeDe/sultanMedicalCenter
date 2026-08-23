import { headers } from "next/headers";
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
    <AdminGate>
      <AdminScreen
        series={series}
        services={services}
        clinic={clinic}
        staff={staff}
        doctors={doctors}
        analytics={analytics}
        appUrl={appUrl}
      />
    </AdminGate>
  );
}
