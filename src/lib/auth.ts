import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { randomBytes, createHash } from "node:crypto";
import { sql } from "@/lib/db";

/*
  Server-side sessions — the trust boundary the app was missing.

  Every privileged server action now begins with one of the require* guards
  below. The client PIN screens still exist, but they are UX: the real check
  is here, against a session cookie the browser cannot forge, because it is
  minted only after a PIN verifies on the server and stored hashed in the
  database.

  Why a hashed token rather than a signed JWT: the clinic already has one
  trusted store (its Postgres), sessions must be revocable (a doctor signs
  out, a manager locks a lost tablet), and revoking a stateless token needs a
  denylist that is itself server state. A row we can delete is simpler and
  strictly safer.
*/

export type Role = "RECEPTION" | "ADMIN" | "DOCTOR";

export type Session = {
  role: Role;
  doctorId: number | null;
  actor: string;
};

const COOKIE = "tg_session";

/*
  Lifetime.

  A clinic day, not a month. These are shared machines at a counter; a
  session that outlived the shift would leave the next person signed in as the
  last. The doctor's idle auto-lock (already in the UI) handles the tablet
  case; this is the hard ceiling.
*/
const TTL_HOURS = 12;

/** The token is hashed before it touches the database, like a password. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mints a session after a PIN has ALREADY been verified, and sets the cookie.
 *
 * Never call this without a preceding verifyPin() success — it is the reward
 * for authentication, not authentication itself.
 */
export async function createSession(s: Session): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + TTL_HOURS * 3600_000);

  await sql`
    insert into auth_session (token_hash, role, doctor_id, actor, expires_at)
    values (${hashToken(token)}, ${s.role}, ${s.doctorId}, ${s.actor}, ${expires})
  `;
  // Opportunistic cleanup; cheap and keeps the table from growing unbounded.
  await sql`select prune_sessions()`.catch(() => {});

  const jar = await cookies();
  jar.set(COOKIE, token, {
    // httpOnly: script cannot read it, so an XSS cannot steal the session.
    httpOnly: true,
    // Only sent over HTTPS in production; allowed on http for local dev.
    secure: process.env.NODE_ENV === "production",
    // Strict: the cookie is never sent on a cross-site request, which is the
    // CSRF defence for the privileged actions it unlocks.
    sameSite: "strict",
    path: "/",
    expires,
  });
}

/** Reads and validates the current session, or null. */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;

  const [row] = await sql<
    { role: Role; doctor_id: number | null; actor: string }[]
  >`
    update auth_session
       set last_seen_at = now()
     where token_hash = ${hashToken(token)}
       and expires_at > now()
    returning role, doctor_id, actor
  `;
  if (!row) return null;
  return { role: row.role, doctorId: row.doctor_id, actor: row.actor };
}

/** Ends the current session and clears the cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    await sql`delete from auth_session where token_hash = ${hashToken(token)}`;
  }
  jar.delete(COOKIE);
}

/*
  Guards.

  Each returns the session or throws. Server actions call these at the top;
  the throw becomes a rejected action, which the client already handles as an
  error. Throwing rather than returning a flag means a forgotten check is a
  hard failure, not a silent bypass.
*/

export class AuthError extends Error {
  constructor() {
    super("Not authorised.");
    this.name = "AuthError";
  }
}

/*
  Exported so actions can tell "this session expired" apart from "the database
  broke". Left unhandled, the guard's throw becomes a 500 and the button that
  triggered it reports nothing at all, which is how an expired doctor session
  looked identical to a dead server.

  Matched by name, not instanceof: the class identity does not survive every
  bundling boundary, and a guard that silently stops recognising its own error
  would fail in the direction of showing a 500 again.
*/
export function isAuthError(err: unknown): boolean {
  return err instanceof Error && err.name === "AuthError";
}

/** Any signed-in staff member (reception, admin, or a doctor). */
export async function requireStaff(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new AuthError();
  return s;
}

/** Reception-level: reception, or admin (admin can do anything reception can). */
export async function requireReception(): Promise<Session> {
  const s = await getSession();
  if (!s || (s.role !== "RECEPTION" && s.role !== "ADMIN"))
    throw new AuthError();
  return s;
}

/** Admin-only: fees, prices, doctor management. */
export async function requireAdmin(): Promise<Session> {
  const s = await getSession();
  if (!s || s.role !== "ADMIN") throw new AuthError();
  return s;
}

/**
 * A specific doctor, or admin acting on their behalf.
 *
 * A doctor may only act on their OWN queue; passing another doctor's id is
 * refused. Admin is exempt so reception/management can drive any queue from
 * the shared /queue screen.
 */
export async function requireDoctor(doctorId: number): Promise<Session> {
  const s = await getSession();
  if (!s) throw new AuthError();
  if (s.role === "ADMIN" || s.role === "RECEPTION") return s;
  if (s.role === "DOCTOR" && s.doctorId === doctorId) return s;
  throw new AuthError();
}

/*
  PIN verification, funnelled through the database's verify_pin so the lockout
  cannot be bypassed. Returns the same shape the old actions did, plus the
  lockout seconds.
*/

export type PinResult = {
  ok: boolean;
  isDefault: boolean;
  lockedSeconds: number;
};

/** Verifies the admin PIN, upgrading its hash to bcrypt on success. */
export async function verifyAdminPin(pin: string): Promise<PinResult> {
  const [cfg] = await sql<
    {
      admin_pin_bcrypt: string | null;
      admin_pin_hash: string | null;
      admin_pin_salt: string | null;
    }[]
  >`select admin_pin_bcrypt, admin_pin_hash, admin_pin_salt
      from clinic_setting where id = 1`;

  const [r] = await sql<
    { ok: boolean; is_default: boolean; locked_seconds: number }[]
  >`select * from verify_pin('admin', ${pin},
        ${cfg?.admin_pin_bcrypt ?? null},
        ${cfg?.admin_pin_hash ?? null},
        ${cfg?.admin_pin_salt ?? null})`;

  if (r?.ok && !cfg?.admin_pin_bcrypt) {
    // Lazy upgrade: the plaintext is in hand exactly once, here, on a correct
    // sign-in. Store the bcrypt so the legacy sha256 path is never used again.
    await sql`update clinic_setting
                 set admin_pin_bcrypt = crypt(${pin}, gen_salt('bf', 10))
               where id = 1`;
  }
  return {
    ok: r?.ok ?? false,
    isDefault: r?.is_default ?? false,
    lockedSeconds: r?.locked_seconds ?? 0,
  };
}

/** Verifies the reception PIN. */
export async function verifyReceptionPin(pin: string): Promise<PinResult> {
  const [cfg] = await sql<{ reception_pin_bcrypt: string | null }[]>`
    select reception_pin_bcrypt from clinic_setting where id = 1`;

  const [r] = await sql<
    { ok: boolean; is_default: boolean; locked_seconds: number }[]
  >`select * from verify_pin('reception', ${pin},
        ${cfg?.reception_pin_bcrypt ?? null}, null, null)`;

  return {
    ok: r?.ok ?? false,
    isDefault: r?.is_default ?? false,
    lockedSeconds: r?.locked_seconds ?? 0,
  };
}

/** Verifies a doctor's PIN, upgrading its hash to bcrypt on success. */
export async function verifyDoctorPin(
  doctorId: number,
  pin: string,
): Promise<PinResult & { name: string | null }> {
  const [doc] = await sql<
    {
      name: string;
      pin_bcrypt: string | null;
      pin_hash: string | null;
      pin_salt: string | null;
    }[]
  >`select name, pin_bcrypt, pin_hash, pin_salt from doctor where id = ${doctorId} and active`;

  if (!doc)
    return { ok: false, isDefault: false, lockedSeconds: 0, name: null };

  const [r] = await sql<
    { ok: boolean; is_default: boolean; locked_seconds: number }[]
  >`select * from verify_pin(${"doctor:" + doctorId}, ${pin},
        ${doc.pin_bcrypt ?? null}, ${doc.pin_hash ?? null}, ${doc.pin_salt ?? null})`;

  if (r?.ok && !doc.pin_bcrypt) {
    await sql`update doctor set pin_bcrypt = crypt(${pin}, gen_salt('bf', 10))
               where id = ${doctorId}`;
  }
  return {
    ok: r?.ok ?? false,
    isDefault: r?.is_default ?? false,
    lockedSeconds: r?.locked_seconds ?? 0,
    name: doc.name,
  };
}

/*
  Page-level guards.

  Server components call these at the top. Unlike the require* helpers (which
  throw, for actions), these REDIRECT — an unauthenticated page visit should
  land on the login screen, not an error. They must run before any gated data
  fetch on the page, so the page's own queries never execute unauthorised.
*/

/** Redirects to the reception login unless a staff session exists. */
export async function guardReceptionPage(returnTo: string): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return s;
}

/**
 * For the admin page. Requires a signed-in session to even reach it; the
 * ADMIN role itself is still gated by the in-page PIN elevation, so a
 * reception user sees the admin login rather than the settings.
 */
export async function guardAdminPage(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(`/login?next=${encodeURIComponent("/admin")}`);
  return s;
}
