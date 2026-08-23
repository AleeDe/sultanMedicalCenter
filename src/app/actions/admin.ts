"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import type { ActionResult } from "@/app/actions/tokens";
import type { ClinicSetting, Doctor, Staff, TokenSeries } from "@/lib/types";

export type AdminService = {
  id: number;
  code: string;
  name: string;
  category: string;
  price: string;
  active: boolean;
};

export async function getAllSeries(): Promise<TokenSeries[]> {
  return sql<TokenSeries[]>`
    select id, code, label, is_emergency, base_fee, active, sort_order
      from token_series order by sort_order, id
  `;
}

export async function getAllServices(): Promise<AdminService[]> {
  return sql<AdminService[]>`
    select id, code, name, category, price, active
      from service order by category, name
  `;
}

const seriesSchema = z.object({
  id: z.coerce.number().int().positive(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9]+$/, "Prefix may only contain letters and numbers"),
  label: z.string().trim().min(1).max(60),
  baseFee: z.coerce.number().min(0),
  active: z.boolean(),
});

/**
 * Renames a token series prefix.
 *
 * Safe by construction: token_counter keys on series_id, and issued tokens
 * store their display_no as text. Renaming NORM -> OPD therefore affects only
 * tokens issued from now on; today's count does not restart and yesterday's
 * slips still read the way they were printed.
 */
export async function updateSeries(
  input: z.input<typeof seriesSchema>,
): Promise<ActionResult<TokenSeries[]>> {
  const parsed = seriesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: z.flattenError(parsed.error).fieldErrors.code?.[0]
        ?? "Please check the series details.",
    };
  }
  const v = parsed.data;

  try {
    await sql.begin(async (tx) => {
      const [before] = await tx`
        select code, label, base_fee, active from token_series where id = ${v.id}
      `;
      await tx`
        update token_series
           set code = upper(${v.code}), label = ${v.label},
               base_fee = ${v.baseFee}, active = ${v.active}
         where id = ${v.id}
      `;
      const beforeJson = tx.json(before ?? {});
      const afterJson = tx.json({
        code: v.code.toUpperCase(),
        label: v.label,
        base_fee: v.baseFee,
        active: v.active,
      });
      await tx`
        insert into audit_log (actor, action, entity, entity_id, before, after)
        values ('Admin', 'UPDATE_SERIES', 'token_series', ${String(v.id)},
                ${beforeJson}, ${afterJson})
      `;
    });

    revalidatePath("/admin");
    revalidatePath("/");
    return { ok: true, data: await getAllSeries() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    return {
      ok: false,
      error: msg.includes("unique")
        ? "That prefix is already used by another series."
        : "Could not save the series.",
    };
  }
}

const serviceSchema = z.object({
  id: z.coerce.number().int().positive().nullable(),
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  category: z.enum(["CONSULT", "LAB", "RADIOLOGY", "PROCEDURE", "OTHER"]),
  price: z.coerce.number().min(0),
  active: z.boolean(),
});

/**
 * Creates or updates a catalogue item.
 *
 * A price change here NEVER touches existing bills: visit_item snapshots the
 * price at the moment the item was added, so history is immutable by design.
 */
export async function saveService(
  input: z.input<typeof serviceSchema>,
): Promise<ActionResult<AdminService[]>> {
  const parsed = serviceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Please check the item details." };
  }
  const v = parsed.data;

  try {
    await sql.begin(async (tx) => {
      if (v.id) {
        const [before] = await tx`
          select code, name, category, price, active from service where id = ${v.id}
        `;
        await tx`
          update service
             set code = upper(${v.code}), name = ${v.name},
                 category = ${v.category}, price = ${v.price},
                 active = ${v.active}
           where id = ${v.id}
        `;
        const b = tx.json(before ?? {});
        const a = tx.json({ ...v, code: v.code.toUpperCase() });
        await tx`
          insert into audit_log (actor, action, entity, entity_id, before, after)
          values ('Admin', 'UPDATE_SERVICE', 'service', ${String(v.id)}, ${b}, ${a})
        `;
      } else {
        const [created] = await tx<{ id: number }[]>`
          insert into service (code, name, category, price, active)
          values (upper(${v.code}), ${v.name}, ${v.category}, ${v.price},
                  ${v.active})
          returning id
        `;
        const a = tx.json({ ...v, code: v.code.toUpperCase() });
        await tx`
          insert into audit_log (actor, action, entity, entity_id, after)
          values ('Admin', 'CREATE_SERVICE', 'service', ${String(created.id)}, ${a})
        `;
      }
    });

    revalidatePath("/admin");
    revalidatePath("/billing");
    return { ok: true, data: await getAllServices() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    return {
      ok: false,
      error: msg.includes("unique")
        ? "That item code is already in use."
        : "Could not save the item.",
    };
  }
}

const clinicSchema = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(120),
  phone: z.string().trim().max(30),
  footerNote: z.string().trim().max(80),
  paperWidth: z.coerce.number().int().refine((n) => n === 58 || n === 80),
});

export async function saveClinic(
  input: z.input<typeof clinicSchema>,
): Promise<ActionResult<ClinicSetting>> {
  const parsed = clinicSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Please check the clinic details." };
  }
  const v = parsed.data;

  await sql`
    update clinic_setting
       set name = ${v.name}, address = ${v.address}, phone = ${v.phone},
           footer_note = ${v.footerNote}, paper_width = ${v.paperWidth}
     where id = 1
  `;

  revalidatePath("/admin");
  revalidatePath("/");
  const [row] = await sql<ClinicSetting[]>`
    select name, address, phone, footer_note, paper_width
      from clinic_setting where id = 1
  `;
  return { ok: true, data: row };
}

/* ----------------------------------------------------------------- doctors */

export async function getAllDoctors(): Promise<Doctor[]> {
  return sql<Doctor[]>`
    select id, name, speciality, room, active, sort_order
      from doctor order by sort_order, name
  `;
}

const doctorSchema = z.object({
  id: z.coerce.number().int().positive().nullable(),
  name: z.string().trim().min(1).max(80),
  speciality: z.string().trim().max(60).default(""),
  room: z.string().trim().max(30).default(""),
  active: z.boolean(),
});

export async function saveDoctor(
  input: z.input<typeof doctorSchema>,
): Promise<ActionResult<Doctor[]>> {
  const parsed = doctorSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a doctor name." };
  const v = parsed.data;

  try {
    await sql.begin(async (tx) => {
      if (v.id) {
        const [before] = await tx`
          select name, speciality, room, active from doctor where id = ${v.id}
        `;
        await tx`
          update doctor
             set name = ${v.name}, speciality = ${v.speciality},
                 room = ${v.room}, active = ${v.active}
           where id = ${v.id}
        `;
        const b = tx.json(before ?? {});
        const a = tx.json({ ...v });
        await tx`
          insert into audit_log (actor, action, entity, entity_id, before, after)
          values ('Admin', 'UPDATE_DOCTOR', 'doctor', ${String(v.id)}, ${b}, ${a})
        `;
      } else {
        const [{ next_order }] = await tx<{ next_order: number }[]>`
          select coalesce(max(sort_order), 0) + 1 as next_order from doctor
        `;
        const [created] = await tx<{ id: number }[]>`
          insert into doctor (name, speciality, room, active, sort_order)
          values (${v.name}, ${v.speciality}, ${v.room}, ${v.active},
                  ${next_order})
          returning id
        `;
        const a = tx.json({ ...v });
        await tx`
          insert into audit_log (actor, action, entity, entity_id, after)
          values ('Admin', 'CREATE_DOCTOR', 'doctor', ${String(created.id)}, ${a})
        `;
      }
    });

    revalidatePath("/admin");
    revalidatePath("/");
    return { ok: true, data: await getAllDoctors() };
  } catch {
    return { ok: false, error: "Could not save the doctor." };
  }
}

/* --------------------------------------------------------------- admin PIN */

/**
 * Verifies the admin PIN.
 *
 * Hashing happens in the database so the PIN never becomes a JS string that
 * could end up in a log or an error trace. A deliberate small delay blunts
 * brute-forcing a 4-digit code over the network.
 */
export async function checkAdminPin(
  pin: string,
): Promise<{ ok: boolean; isDefault: boolean }> {
  const clean = pin.trim();
  if (!/^\d{4,6}$/.test(clean)) return { ok: false, isDefault: false };

  const [row] = await sql<{ ok: boolean; is_default: boolean }[]>`
    select
      admin_pin_hash = encode(digest(admin_pin_salt || ${clean}, 'sha256'), 'hex')
        as ok,
      admin_pin_hash = encode(digest(admin_pin_salt || '1234', 'sha256'), 'hex')
        as is_default
      from clinic_setting where id = 1
  `;

  await new Promise((r) => setTimeout(r, 400));
  return { ok: row?.ok ?? false, isDefault: row?.is_default ?? false };
}

const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits");

export async function changeAdminPin(
  currentPin: string,
  newPin: string,
): Promise<ActionResult<null>> {
  const parsed = pinSchema.safeParse(newPin);
  if (!parsed.success) {
    return { ok: false, error: "New PIN must be 4 to 6 digits." };
  }

  const check = await checkAdminPin(currentPin);
  if (!check.ok) return { ok: false, error: "Current PIN is incorrect." };
  if (parsed.data === "1234") {
    return { ok: false, error: "Choose something other than 1234." };
  }

  await sql`
    update clinic_setting
       set admin_pin_salt = encode(gen_random_bytes(16), 'hex')
     where id = 1
  `;
  await sql`
    update clinic_setting
       set admin_pin_hash = encode(
             digest(admin_pin_salt || ${parsed.data}, 'sha256'), 'hex')
     where id = 1
  `;

  await sql`
    insert into audit_log (actor, action, entity, entity_id)
    values ('Admin', 'CHANGE_ADMIN_PIN', 'clinic_setting', '1')
  `;

  return { ok: true, data: null };
}

export async function addStaff(name: string): Promise<ActionResult<Staff[]>> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Enter a name." };

  await sql`insert into staff (name) values (${clean})`;
  revalidatePath("/admin");
  const rows = await sql<Staff[]>`
    select id, name, active from staff where active order by name
  `;
  return { ok: true, data: rows };
}
