export type Gender = "MALE" | "FEMALE" | "OTHER";

export type TokenSeries = {
  id: number;
  code: string;
  label: string;
  is_emergency: boolean;
  base_fee: string;
  active: boolean;
  sort_order: number;
};

export type Patient = {
  id: number;
  mrn: string;
  name: string;
  phone: string;
  gender: Gender;
  age_years: number | null;
  address: string;
};

export type LoyaltyTier = "NEW" | "REGULAR" | "GOLD";

export type PatientWithTier = Patient & {
  visit_count: number;
  tier: LoyaltyTier;
};

/**
 * What reception sees the moment they pick a returning patient. Everything
 * here is derived from visit history — none of it is an editable column, so
 * it cannot drift out of step with what actually happened.
 */
export type PatientSummary = {
  visit_count: number;         // lifetime, not the 12-month tier window
  first_seen: string | null;
  last_seen: string | null;
  usual_doctor_id: number | null;
  usual_doctor_name: string | null;
  recent: RecentVisit[];
};

export type RecentVisit = {
  visit_id: number;
  visit_date: string;
  doctor_name: string | null;
  series_label: string;
};

/** How a search box entry was interpreted, so the UI can say so. */
export type PatientMatchKind = "MRN" | "PHONE" | "NAME";

export type PatientSearchResult = {
  kind: PatientMatchKind;
  matches: PatientWithTier[];
};

export type IssuedToken = {
  token_id: number;
  visit_id: number;
  display_no: string;
  unique_id: string;
  seq: number;
  token_date: string;
  issued_at: string;
};

/** One printed line on the token slip: the consultation fee, then any labs. */
export type ReceiptLine = { name: string; amount: string };

export type TokenReceipt = IssuedToken & {
  patient_name: string;
  mrn: string;
  gender: Gender;
  age_years: number | null;
  series_label: string;
  is_emergency: boolean;
  doctor_name: string | null;
  doctor_room: string | null;
  /**
   * Minutes quoted to the patient at issue time.
   *
   * Deliberately an over-estimate: patients given a moderately overestimated
   * wait report the highest satisfaction, while an honest median produces no
   * gain at all. Stored on the token too, so actual-vs-quoted can be measured
   * and the multiplier tuned against this clinic rather than guessed.
   */
  wait_minutes: number | null;
  /** Consultation/emergency fee alone. */
  fee: string;
  /** Every charge on the slip — the visit fee plus any labs added up front. */
  lines: ReceiptLine[];
  /** Sum of `lines`, i.e. what the patient actually paid at the counter. */
  total: string;
  tier: LoyaltyTier;
};

export type ClinicSetting = {
  name: string;
  address: string;
  phone: string;
  footer_note: string;
  paper_width: number;
};

export type Staff = { id: number; name: string; active: boolean };

export type Doctor = {
  id: number;
  name: string;
  speciality: string;
  room: string;
  active: boolean;
  sort_order: number;
};
