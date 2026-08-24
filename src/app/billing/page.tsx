import { BillingScreen } from "@/components/BillingScreen";
import { guardReceptionPage } from "@/lib/auth";
import { getOpenVisits, getServices } from "@/app/actions/ledger";
import { getClinic, getStaff } from "@/app/actions/tokens";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  await guardReceptionPage("/billing");
  const [services, openVisits, clinic, staff] = await Promise.all([
    getServices(),
    getOpenVisits(),
    getClinic(),
    getStaff(),
  ]);

  return (
    <BillingScreen
      services={services}
      openVisits={openVisits}
      clinic={clinic}
      staff={staff}
    />
  );
}
