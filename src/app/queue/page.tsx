import { QueueBoard } from "@/components/QueueBoard";
import { guardReceptionPage } from "@/lib/auth";
import { getQueues } from "@/app/actions/queue";

export const dynamic = "force-dynamic";

/** Reception's view: every doctor's queue on one screen. */
export default async function QueuePage() {
  await guardReceptionPage("/queue");
  const queues = await getQueues();

  return (
    <div className="mx-auto max-w-4xl px-5 py-5">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-[22px] font-bold tracking-tight">Queue</h1>
        <p className="text-sm text-muted">
          {new Date().toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
      </div>
      <QueueBoard initial={queues} />
    </div>
  );
}
