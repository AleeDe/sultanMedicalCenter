"use client";

import { leaseTake, cacheGet } from "./db";
import { outboxAdd } from "./db";
import type { SyncTokenInput } from "@/app/actions/offline";
import type { ServiceRow } from "@/app/actions/ledger";
import type { Gender, LoyaltyTier, TokenReceipt } from "@/lib/types";

/*
  Issuing a token with no server.

  The number does not come from anywhere clever — it comes from a block this
  machine leased earlier, while the connection was up. That is the whole
  trick: the right to these numbers was acquired in advance, so printing one
  now cannot collide with anything the server issues in the meantime.

  Everything else the receipt needs (doctor name, room, series label, prices)
  is already on screen, so the slip is assembled locally and prints
  immediately. The write is queued and delivered whenever the link returns.
*/

type Payload = {
  patientId: number | null;
  name: string;
  phone: string;
  gender: Gender;
  age: number | null;
  address: string;
  seriesId: number;
  fee: number;
  staffId: number | null;
  serviceIds: number[];
  doctorId: number | null;
};

type Context = {
  seriesCode: string;
  seriesLabel: string;
  isEmergency: boolean;
  doctorName: string | null;
  doctorRoom: string | null;
  tier: LoyaltyTier;
  services: ServiceRow[];
};

export type OfflineResult =
  | { ok: true; data: TokenReceipt }
  | { ok: false; error: string };

export async function issueOffline(
  p: Payload,
  ctx: Context,
): Promise<OfflineResult> {
  const taken = await leaseTake(p.seriesId).catch(() => null);

  if (!taken) {
    /*
      Refusing is the correct behaviour here, and worth being blunt about.

      Inventing a number would risk handing two patients the same token,
      which is a dispute at the counter that no later sync can undo. Better
      to stop and say so than to print something that might be wrong.
    */
    return {
      ok: false,
      error:
        "No connection, and this counter has no reserved token numbers left. " +
        "Reconnect to the internet to continue issuing tokens.",
    };
  }

  const now = new Date();
  const clientUuid = crypto.randomUUID();
  const visitUuid = crypto.randomUUID();
  // A patient created offline has no MRN yet — that series is server-owned
  // and must stay gapless, so it is assigned at sync.
  const patientUuid = p.patientId ? null : crypto.randomUUID();

  const displayNo = `${ctx.seriesCode}-${String(taken.seq).padStart(5, "0")}`;
  const uniqueId =
    `${ctx.seriesCode}-` +
    `${String(now.getDate()).padStart(2, "0")}` +
    `${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${now.getFullYear()}-` +
    `${String(taken.seq).padStart(5, "0")}`;

  const queued: SyncTokenInput = {
    clientUuid,
    visitUuid,
    patientUuid,
    patientId: p.patientId,
    name: p.name,
    phone: p.phone,
    gender: p.gender,
    age: p.age,
    address: p.address,
    seriesId: p.seriesId,
    doctorId: p.doctorId,
    staffId: p.staffId,
    fee: p.fee,
    serviceIds: p.serviceIds,
    seq: taken.seq,
    leaseId: taken.leaseId,
    issuedAt: now.toISOString(),
  };

  await outboxAdd({
    id: clientUuid,
    kind: "ISSUE_TOKEN",
    payload: queued,
    createdAt: now.getTime(),
    attempts: 0,
  });

  const lines = [
    { name: `${ctx.seriesLabel} Fee`, amount: p.fee.toFixed(2) },
    ...ctx.services.map((s) => ({
      name: s.name,
      amount: Number(s.price).toFixed(2),
    })),
  ];
  const total = lines.reduce((sum, l) => sum + Number(l.amount), 0);

  // The MRN is genuinely not known yet. Showing a placeholder is honest;
  // inventing a plausible-looking one would put a wrong number on paper.
  const mrn = p.patientId
    ? ((await cacheGet<string>(`mrn:${p.patientId}`)) ?? "—")
    : "— (offline)";

  return {
    ok: true,
    data: {
      token_id: -1,
      visit_id: -1,
      display_no: displayNo,
      unique_id: uniqueId,
      seq: taken.seq,
      token_date: now.toISOString().slice(0, 10),
      issued_at: now.toISOString(),
      patient_name: p.name,
      mrn,
      gender: p.gender,
      age_years: p.age,
      series_label: ctx.seriesLabel,
      is_emergency: ctx.isEmergency,
      doctor_name: ctx.doctorName,
      doctor_room: ctx.doctorRoom,
      // No estimate offline: the queue lives on the server, and a guessed
      // number printed on a slip is worse than none — an under-estimate is
      // precisely the error patients react worst to.
      wait_minutes: null,
      fee: p.fee.toFixed(2),
      lines,
      total: total.toFixed(2),
      tier: ctx.tier,
    },
  };
}
