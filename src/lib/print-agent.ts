/*
  Talks to the local print agent from the browser.

  The app is served from Vercel, so the server rendering a token is in a data
  centre with no printer attached. The printer is on a COM port of the
  reception PC, held by print-agent/agent.mjs. The browser is the only party
  that can reach both, so it posts the slip bytes to the agent on localhost.

  Two things make this work from an https page:

   * Browsers exempt http://127.0.0.1 from mixed-content blocking, so an https
     Vercel page may call it. This is a deliberate carve-out for exactly this
     "local hardware bridge" case.
   * connect-src in the CSP (next.config.ts) must list the agent's origin, or
     the request never leaves the page.

  127.0.0.1 rather than "localhost": some browsers resolve localhost to ::1
  first, and the agent binds to IPv4, so the name form can fail where the
  literal address does not.
*/

const AGENT_ORIGIN = "http://127.0.0.1:3001";

/** Short: an unreachable agent must not stall the print, it must fall through
    to the next route while reception is still standing at the counter. */
const TIMEOUT_MS = 2500;

export type AgentResult =
  | { ok: true; port: string; bytes: number }
  | { ok: false; error: string };

async function call(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${AGENT_ORIGIN}${path}`, {
      ...init,
      signal: controller.signal,
      // The agent authorises by Origin alone and holds no session; sending
      // credentials would be pointless and widens what a stray page could do.
      credentials: "omit",
    });
  } catch {
    // Agent not running, or blocked. Both are "no local printer here".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the agent is running and can see a printer. */
export async function agentStatus(): Promise<{ ready: boolean; port?: string }> {
  const res = await call("/status");
  if (!res?.ok) return { ready: false };
  try {
    const body = await res.json();
    return { ready: body.ready === true, port: body.port ?? undefined };
  } catch {
    return { ready: false };
  }
}

/**
 * Sends ESC/POS bytes to the printer via the local agent.
 *
 * The bytes are built by src/lib/receipts.ts, the same builder the WebUSB
 * route uses, so every route prints identical paper.
 */
export async function printViaAgent(bytes: Uint8Array): Promise<AgentResult> {
  const res = await call("/print", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bytes: Array.from(bytes) }),
  });

  if (!res) {
    return {
      ok: false,
      error:
        "The print agent is not running on this PC. Start it, or use the browser print dialog.",
    };
  }
  if (!res.ok) {
    return { ok: false, error: `Print agent returned ${res.status}.` };
  }

  try {
    return (await res.json()) as AgentResult;
  } catch {
    return { ok: false, error: "The print agent sent an unreadable reply." };
  }
}
