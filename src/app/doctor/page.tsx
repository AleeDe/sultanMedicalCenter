import { DoctorConsole } from "@/components/DoctorConsole";
import { getDoctors } from "@/app/actions/tokens";

export const dynamic = "force-dynamic";

/**
 * The doctor's own screen.
 *
 * Deliberately a separate route from /queue: a doctor working from a tablet
 * in their room should see only their own patients, at a size they can press
 * without looking away from the person in front of them.
 */
export default async function DoctorPage() {
  const doctors = await getDoctors();
  return <DoctorConsole doctors={doctors} />;
}
