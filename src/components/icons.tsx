/*
  Inline SVG icons. Emoji were tried first and read as flat coloured blobs
  that clash with the type — these inherit currentColor and stroke weight, so
  they sit properly in the design.
*/

type P = { className?: string };
const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconStethoscope({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M4.5 3v5a4 4 0 0 0 8 0V3" />
      <path d="M4.5 3H3m9.5 0H14" />
      <path d="M8.5 12v2.5a5.5 5.5 0 0 0 11 0V13" />
      <circle cx="19.5" cy="10.5" r="2.5" />
    </svg>
  );
}

export function IconAmbulance({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M2 7.5h11v9H2z" />
      <path d="M13 10.5h4l3 3.2v2.8h-7z" />
      <circle cx="7" cy="18" r="1.8" />
      <circle cx="17" cy="18" r="1.8" />
      <path d="M7.5 10.5v3M6 12h3" />
    </svg>
  );
}

export function IconTicket({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M3 8.5V6.5h18v2a2 2 0 0 0 0 7v2H3v-2a2 2 0 0 0 0-7z" />
      <path d="M12 7v2m0 3v2m0 3v2" strokeDasharray="0.1 3.2" />
    </svg>
  );
}

export function IconReceipt({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M5 3h14v18l-2.3-1.6L14.4 21l-2.4-1.6L9.6 21l-2.3-1.6L5 21z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}

export function IconBook({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z" />
      <path d="M4 17h15" />
      <path d="M8.5 7.5h6" />
    </svg>
  );
}

export function IconGear({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
    </svg>
  );
}

export function IconSearch({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

export function IconCheck({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} strokeWidth={2.4} aria-hidden>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

export function IconPlus({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} strokeWidth={2.2} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconCross({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} strokeWidth={2.2} aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconPrinter({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M7 8V3h10v5" />
      <path d="M5 8h14a2 2 0 0 1 2 2v6h-4v5H7v-5H3v-6a2 2 0 0 1 2-2z" />
      <path d="M7 14h10" />
    </svg>
  );
}

export function IconStar({ className = "h-5 w-5" }: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="m12 3.5 2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.9l6.1-.8z" />
    </svg>
  );
}

export function IconArrowLeft({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
    </svg>
  );
}

export function IconFlask({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M9.5 3v6.2L4.8 17a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3l-4.7-7.8V3" />
      <path d="M8 3h8" />
      <path d="M7 14h10" />
    </svg>
  );
}

export function IconChevron({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconLock({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function IconEye({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconEyeOff({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.8A17 17 0 0 0 2 13s3.5 7 10 7a9.7 9.7 0 0 0 4.7-1.2" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m3 3 18 18" />
    </svg>
  );
}

export function IconMedical({ className = "h-5 w-5" }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M9.5 2h5v5.5H20v5h-5.5V18h-5v-5.5H4v-5h5.5z" />
    </svg>
  );
}

export function IconMoon({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

export function IconSun({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** The waiting-room TV. A screen on a stand, not a generic monitor glyph. */
export function IconDisplay({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8 20.5h8M12 16.5v4" />
    </svg>
  );
}

export function IconSpeaker({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="M16 9a4 4 0 0 1 0 6" />
      <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

export function IconSpeakerOff({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      <path d="m16.5 9.5 5 5m0-5-5 5" />
    </svg>
  );
}

export function IconBell({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className} aria-hidden>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5Z" />
      <path d="M10.5 19a1.8 1.8 0 0 0 3 0" />
    </svg>
  );
}
