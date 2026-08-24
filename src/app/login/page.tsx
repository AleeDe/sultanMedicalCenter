import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginScreen } from "@/components/LoginScreen";

export const dynamic = "force-dynamic";

/**
 * The reception sign-in page.
 *
 * Anyone already signed in is sent straight on — there is no reason to show
 * the door to someone already inside.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  const { next } = await searchParams;

  if (session) redirect(next && next.startsWith("/") ? next : "/");

  // Only same-origin paths are honoured as a redirect target, so the ?next
  // parameter cannot be used to bounce a signed-in user to another site.
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return <LoginScreen next={safeNext} />;
}
