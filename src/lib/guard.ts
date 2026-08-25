import "server-only";
import { isAuthError } from "@/lib/auth";

/*
  Turns an expired session into an answer instead of a 500.

  Every queue action begins with a require* guard, and those guards throw. A
  throw that escapes a server action becomes an HTTP 500, and the client sees
  a rejected promise with nothing readable in it — the doctor pressed Call
  next, the request failed, and the screen said nothing at all. That is the
  worst possible reporting of the most ordinary condition on this screen: a
  tablet whose 12-hour session ran out overnight.

  So the guard's own error is caught and reported in the shape the client
  already handles. Anything else still throws, because a broken database must
  not be dressed up as a permission problem.

  This lives outside the "use server" file deliberately: every export there is
  exposed as a callable server action, and a helper is not one.
*/
export async function guarded<T>(
  body: () => Promise<T>,
  onAuthError = "Your session has expired. Sign in again.",
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await body() };
  } catch (err) {
    if (isAuthError(err)) return { ok: false, error: onAuthError };
    throw err;
  }
}
