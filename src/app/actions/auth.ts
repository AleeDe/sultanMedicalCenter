"use server";

import {
  createSession,
  destroySession,
  getSession,
  verifyAdminPin,
  verifyDoctorPin,
  verifyReceptionPin,
  type Role,
  type Session,
} from "@/lib/auth";
import { sql } from "@/lib/db";

/*
  Sign-in / sign-out.

  These are the only actions that run WITHOUT a session (obviously — they are
  how you get one). Everything they touch goes through verify_pin in the
  database, which owns the lockout, so there is no unthrottled path to a PIN
  check anywhere.
*/

export type SignInResult =
  | { ok: true; role: Role; isDefault: boolean }
  | { ok: false; error: string; lockedSeconds?: number };

function pinShape(pin: string): string | null {
  const clean = pin.trim();
  return /^\d{4,6}$/.test(clean) ? clean : null;
}

function lockMessage(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m > 1
    ? `Too many attempts. Try again in ${m} minutes.`
    : `Too many attempts. Try again in ${seconds} seconds.`;
}

/** Reception sign-in. */
export async function signInReception(pin: string): Promise<SignInResult> {
  const clean = pinShape(pin);
  if (!clean) return { ok: false, error: "PIN must be 4 to 6 digits." };

  const r = await verifyReceptionPin(clean);
  if (r.lockedSeconds > 0) {
    return { ok: false, error: lockMessage(r.lockedSeconds), lockedSeconds: r.lockedSeconds };
  }
  if (!r.ok) return { ok: false, error: "Incorrect PIN." };

  await createSession({ role: "RECEPTION", doctorId: null, actor: "Reception" });
  return { ok: true, role: "RECEPTION", isDefault: r.isDefault };
}

/** Admin sign-in. Grants the reception surface plus the settings that change money. */
export async function signInAdmin(pin: string): Promise<SignInResult> {
  const clean = pinShape(pin);
  if (!clean) return { ok: false, error: "PIN must be 4 to 6 digits." };

  const r = await verifyAdminPin(clean);
  if (r.lockedSeconds > 0) {
    return { ok: false, error: lockMessage(r.lockedSeconds), lockedSeconds: r.lockedSeconds };
  }
  if (!r.ok) return { ok: false, error: "Incorrect PIN." };

  await createSession({ role: "ADMIN", doctorId: null, actor: "Admin" });
  return { ok: true, role: "ADMIN", isDefault: r.isDefault };
}

/** Doctor sign-in. Grants only that doctor's own queue. */
export async function signInDoctor(
  doctorId: number,
  pin: string,
): Promise<SignInResult> {
  const clean = pinShape(pin);
  if (!clean) return { ok: false, error: "PIN must be 4 to 6 digits." };
  if (!Number.isInteger(doctorId) || doctorId < 1) {
    return { ok: false, error: "Unknown doctor." };
  }

  const r = await verifyDoctorPin(doctorId, clean);
  if (r.lockedSeconds > 0) {
    return { ok: false, error: lockMessage(r.lockedSeconds), lockedSeconds: r.lockedSeconds };
  }
  if (!r.ok) return { ok: false, error: "Incorrect PIN." };

  await createSession({
    role: "DOCTOR",
    doctorId,
    actor: r.name ?? "Doctor",
  });
  return { ok: true, role: "DOCTOR", isDefault: r.isDefault };
}

/** Signs out and clears the session. */
export async function signOut(): Promise<void> {
  await destroySession();
}

/** The current session, for the client to render the right chrome. */
export async function currentSession(): Promise<Session | null> {
  return getSession();
}

/**
 * Whether any credential still uses the default 1234.
 *
 * Drives the go-live warning. Reads the hashes and tests them against the
 * default; deliberately available to a signed-in session only, since it is
 * shown inside the app.
 */
export async function defaultPinActors(): Promise<string[]> {
  const s = await getSession();
  if (!s) return [];

  const out: string[] = [];
  const [cfg] = await sql<
    {
      admin_pin_bcrypt: string | null;
      admin_pin_hash: string | null;
      admin_pin_salt: string | null;
      reception_pin_bcrypt: string | null;
    }[]
  >`select admin_pin_bcrypt, admin_pin_hash, admin_pin_salt, reception_pin_bcrypt
      from clinic_setting where id = 1`;

  const isDefault = async (
    bcryptHash: string | null,
    shaHash: string | null,
    shaSalt: string | null,
  ) => {
    if (bcryptHash) {
      const [r] = await sql<{ d: boolean }[]>`select (${bcryptHash} = crypt('1234', ${bcryptHash})) d`;
      return r?.d ?? false;
    }
    if (shaHash) {
      const [r] = await sql<{ d: boolean }[]>`
        select (${shaHash} = encode(digest(coalesce(${shaSalt},'') || '1234','sha256'),'hex')) d`;
      return r?.d ?? false;
    }
    return false;
  };

  if (await isDefault(cfg?.reception_pin_bcrypt ?? null, null, null)) out.push("Reception");
  if (await isDefault(cfg?.admin_pin_bcrypt ?? null, cfg?.admin_pin_hash ?? null, cfg?.admin_pin_salt ?? null)) {
    out.push("Admin");
  }

  const docs = await sql<{ name: string; pin_bcrypt: string | null; pin_hash: string | null; pin_salt: string | null }[]>`
    select name, pin_bcrypt, pin_hash, pin_salt from doctor where active order by sort_order, name`;
  for (const d of docs) {
    if (await isDefault(d.pin_bcrypt, d.pin_hash, d.pin_salt)) out.push(d.name);
  }
  return out;
}
