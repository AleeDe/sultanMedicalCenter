import type { NextConfig } from "next";

/*
  Security response headers (TG-05).

  These apply to every route. They are defence-in-depth around the session
  auth, not a replacement for it: even with a valid session, these limit what
  a compromised or malicious page can do.
*/
const securityHeaders = [
  // Stop the app being framed by another site — clickjacking defence. The
  // waiting-room board and admin should never be embedded anywhere.
  { key: "X-Frame-Options", value: "DENY" },
  // Don't let the browser second-guess declared content types.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send no referrer to other origins.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // This app needs no camera, mic or geolocation; deny them outright.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Force HTTPS for two years, subdomains included. Harmless on localhost
  // (browsers ignore HSTS without TLS); real on the deployed origin.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  /*
    Content-Security-Policy.

    'self' for scripts/styles/fonts/media, which covers the app, its rendered
    voice clips and Next's own inline needs. 'unsafe-inline' is included for
    style and script because Next injects inline bootstrap; tightening this to
    a nonce is a follow-up. frame-ancestors 'none' is the CSP-level twin of
    X-Frame-Options for browsers that honour it.
  */
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },

  /*
    serialport is a native addon: it loads a compiled .node binary at runtime.
    Bundling it breaks that load, and because src/lib/serial-printer.ts treats
    an import failure as "no printer on this machine", the breakage surfaced as
    the browser print dialog appearing instead of a slip — a silent fallback,
    with the real cause only in the server log. Kept external so Node requires
    it from node_modules directly.
  */
  serverExternalPackages: ["serialport"],

  /*
    Server Action origin allowlist (TG-06).

    Next already rejects a Server Action whose Origin does not match the Host,
    which is its built-in CSRF defence. This pins the set of hosts explicitly
    so a misconfigured proxy or an added preview domain cannot silently widen
    it. It works together with the SameSite=Strict session cookie: the cookie
    stops a cross-site request from carrying the session, and this stops one
    from invoking an action at all.

    Add real deployment hosts here (the clinic's domain, the Vercel project
    URL). Localhost covers development.
  */
  experimental: {
    serverActions: {
      allowedOrigins: [
        "localhost:3000",
        // next dev moves to 3001 when 3000 is already taken — a stale dev
        // server left running is enough to cause it. Without this entry every
        // Server Action on that port is rejected, printing included.
        "localhost:3001",
        "sultan-medical-center.vercel.app",
      ],
    },
  },
};

export default nextConfig;
