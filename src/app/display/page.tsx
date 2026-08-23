import { DisplayBoard } from "@/components/DisplayBoard";
import { getQueues } from "@/app/actions/queue";
import { getClinic } from "@/app/actions/tokens";

export const dynamic = "force-dynamic";

/**
 * The waiting-room board.
 *
 * A queue display measurably shortens the wait patients *perceive* — in one
 * ED trial the informed group reported a shorter wait than they had actually
 * had, while the uninformed group reported a far longer one. That effect is
 * the whole reason this screen exists, and it is why it shows both position
 * and minutes: position proves nobody is being skipped, minutes let someone
 * step out for tea.
 */
export default async function DisplayPage() {
  const [queues, clinic] = await Promise.all([getQueues(), getClinic()]);
  return <DisplayBoard initial={queues} clinicName={clinic.name} />;
}
