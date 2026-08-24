import { NewTokenForm } from "@/components/NewTokenForm";
import { RoleLauncher } from "@/components/RoleLauncher";
import {
  getClinic,
  getDoctors,
  getSeries,
  getStaff,
} from "@/app/actions/tokens";
import { getServices } from "@/app/actions/ledger";

export const dynamic = "force-dynamic";

export default async function NewTokenPage() {
  const [series, clinic, staff, services, doctors] = await Promise.all([
    getSeries(),
    getClinic(),
    getStaff(),
    getServices(),
    getDoctors(),
  ]);

  return (
    <>
      <NewTokenForm
        series={series}
        clinic={clinic}
        staff={staff}
        services={services}
        doctors={doctors}
      />
      {/* The doctor console and waiting-room board, which were previously
          reachable only by typing their URL. */}
      <div className="mx-auto max-w-6xl px-5 pb-8">
        <RoleLauncher />
      </div>
    </>
  );
}
