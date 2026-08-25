import type { PatientMatchKind } from "./types";

/**
 * Classifies what reception typed. One box, three kinds of input, because
 * asking them to pick a search mode first costs a keystroke on every single
 * patient and they will pick wrong under pressure.
 *
 * Order matters. MRN is tested before phone because both are digit-heavy and
 * an MRN is the stronger claim: if it parses as an MRN, the patient is
 * holding their slip and we should not go fishing in the phone column.
 */
export function classifyQuery(raw: string): PatientMatchKind {
  const q = raw.trim();
  // BT-260825-0417, or the legacy MRN-000451. Also accept a bare tail
  // (260825-0417) since reception often skips the prefix.
  if (/^[A-Za-z]{1,4}-\d{6}-\d{1,6}$/.test(q)) return "MRN";
  if (/^\d{6}-\d{1,6}$/.test(q)) return "MRN";
  if (/^[A-Za-z]{1,4}-\d{4,8}$/.test(q)) return "MRN";
  // Phone: digits, possibly with the separators people paste in.
  if (/^[\d\s()+-]{4,}$/.test(q)) return "PHONE";
  return "NAME";
}
