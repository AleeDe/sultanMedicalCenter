"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  issueToken,
  findPatients,
  getPatientSummary,
  previewWait,
  type ActionResult,
} from "@/app/actions/tokens";
import { TokenSlip } from "@/components/TokenSlip";
import { Alert, Badge, Button, Card, Field, GroupLabel, Segmented } from "@/components/ui";
import {
  IconAmbulance,
  IconCheck,
  IconChevron,
  IconCross,
  IconFlask,
  IconPlus,
  IconPrinter,
  IconSearch,
  IconStar,
  IconStethoscope,
} from "@/components/icons";
import {
  getPrintState,
  reprintToken,
  type PrintState,
} from "@/app/actions/print";
import type { ServiceRow } from "@/app/actions/ledger";
import type { WaitPreview } from "@/app/actions/tokens";
import { TIER_LABEL } from "@/lib/loyalty";
import { issueOffline } from "@/lib/offline/issue";
import type {
  ClinicSetting,
  Doctor,
  Gender,
  PatientWithTier,
  PatientMatchKind,
  PatientSummary,
  Staff,
  TokenReceipt,
  TokenSeries,
} from "@/lib/types";

/*
  THE HOT PATH.

  The mental model this is built around: the receptionist's task is "give this
  person a number", not "complete a patient record". So the screen is shaped
  like the conversation at the counter, in the order it actually happens:

    1. Is this an emergency?      <- known before the patient finishes speaking
    2. Who are they?              <- phone first, because most are returning
    3. Hand over the slip.

  Consequences:
   * Visit type leads and repaints the whole screen. "Am I issuing an
     emergency token?" is answerable from across the room.
   * The slip preview is always visible on the right, filling in as they type.
     The product of the task is on screen during the task, not revealed after
     it — this is what makes the screen feel like issuing a token rather than
     filling a form.
   * One screen. No wizard, no modal on the happy path.
   * Enter moves forward through the form; F2 issues from anywhere.
   * Nothing reorders itself. A practised user works from muscle memory and a
     moving target costs far more than a longer list.
*/

const EMPTY = {
  patientId: null as number | null,
  name: "",
  phone: "",
  gender: "" as Gender | "",
  age: "",
  address: "",
};

export function NewTokenForm({
  series,
  clinic,
  staff,
  services,
  doctors,
}: {
  series: TokenSeries[];
  clinic: ClinicSetting;
  staff: Staff[];
  services: ServiceRow[];
  doctors: Doctor[];
}) {
  const [form, setForm] = useState(EMPTY);
  const [seriesId, setSeriesId] = useState<number>(series[0]?.id ?? 0);
  const [feeOverride, setFeeOverride] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<number | null>(staff[0]?.id ?? null);
  const [matches, setMatches] = useState<PatientWithTier[]>([]);
  const [forceNew, setForceNew] = useState(false);
  const [tier, setTier] = useState<PatientWithTier["tier"] | null>(null);
  const [lastVisit, setLastVisit] = useState<string | null>(null);
  /*
    The search box is deliberately NOT bound to form.phone any more. It takes
    an MRN or a name too, and writing either of those into the patient's phone
    column — which is what binding them together would do — corrupts the
    record of every patient found by name.
  */
  const [query, setQuery] = useState("");
  const [queryKind, setQueryKind] = useState<PatientMatchKind | null>(null);
  const [summary, setSummary] = useState<PatientSummary | null>(null);
  const [selectedMrn, setSelectedMrn] = useState<string | null>(null);
  /*
    The wait, mirrored on the fee override above it: null means "use what the
    algorithm said", a string means reception typed over it. Kept as a string
    so the field can be emptied while typing without snapping back to 0.
  */
  const [waitOverride, setWaitOverride] = useState<string | null>(null);
  const [waitPreview, setWaitPreview] = useState<WaitPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TokenReceipt | null>(null);
  const [picked, setPicked] = useState<ServiceRow[]>([]);
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const phoneRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const active = series.find((s) => s.id === seriesId);
  const emergency = active?.is_emergency ?? false;
  const fee = feeOverride ?? (active ? String(Number(active.base_fee)) : "0");
  // Doctor is required: reception must record who the patient is going to see.
  const ready =
    form.name.trim().length > 0 && form.gender !== "" && doctorId !== null;
  const doctor = doctors.find((d) => d.id === doctorId) ?? null;
  // What the slip will print: the override if reception typed one, otherwise
  // the live estimate. Kept here so the screen and the paper cannot disagree.
  const quotedWait =
    waitOverride !== null && waitOverride.trim() !== ""
      ? Number(waitOverride)
      : (waitPreview?.minutes ?? 0);

  // The patient pays once at the counter, so the slip total is the visit fee
  // plus every lab picked here.
  const labsTotal = picked.reduce((s, p) => s + Number(p.price), 0);
  const grandTotal = Number(fee || 0) + labsTotal;

  useEffect(() => {
    phoneRef.current?.focus();
  }, []);

  /*
    Keep the quoted wait in step with the doctor and the visit type, because
    both change it: an emergency skips the queue, and each doctor has their
    own pace and their own break.

    Any manual override is dropped when they change — a "20" typed for Dr.
    Khan is not a statement about Dr. Malik's queue, and silently carrying it
    across would print a number nobody chose.
  */
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (doctorId === null) return null;
      // Offline: resolve to null so the slip carries no wait, as before.
      return previewWait(doctorId, emergency).catch(() => null);
    };

    /*
      Re-read while the form is open, because the queue moves underneath it.

      Computed once when the doctor was picked, this number went stale the
      moment another counter issued a token — reception read "7 min" off the
      screen and the slip then printed a longer wait, which looks like a bug
      to them and to the patient holding both.

      An override is left alone: reception typed that on purpose, and having
      it silently replaced by a poll would be worse than it being stale.
    */
    const pull = () =>
      load().then((w) => {
        if (!live) return;
        setWaitPreview(w);
      });

    load().then((w) => {
      if (!live) return;
      setWaitPreview(w);
      setWaitOverride(null);
    });

    const timer = window.setInterval(pull, 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [doctorId, emergency]);

  const submit = useCallback(() => {
    setError(null);
    startTransition(async () => {
      // Guard against a silent duplicate: a known phone typed without pressing
      // Find would create a second MRN for the same person.
      if (!form.patientId && !forceNew && form.phone.trim().length >= 4) {
        /*
          Offline, the duplicate check simply cannot run — the patient list
          lives on the server. Skipping it is the right call: refusing to
          issue a token because we cannot verify uniqueness would stop the
          clinic dead, and a duplicate patient record is a merge job later,
          not a crisis now.
        */
        const res = await findPatients(form.phone).catch(() => null);
        if (res === null) {
          // fall through to issuing; the server reconciles on sync
        } else if (res.matches.length === 1) {
          applyPatient(res.matches[0]);
          setError(
            `${res.matches[0].name} already uses this number (${res.matches[0].mrn}). Details filled in — issue again to confirm.`,
          );
          return;
        } else if (res.matches.length > 1) {
          setMatches(res.matches);
          setError("Several patients use this number. Choose which one.");
          return;
        }
      }

      const payload = {
        patientId: form.patientId,
        name: form.name,
        phone: form.phone,
        gender: (form.gender || "OTHER") as Gender,
        age: form.age === "" ? null : Number(form.age),
        address: form.address,
        seriesId,
        fee: Number(fee),
        staffId,
        serviceIds: picked.map((p) => p.id),
        doctorId,
        waitOverride:
          waitOverride === null || waitOverride.trim() === ""
            ? null
            : Number(waitOverride),
        // What the screen was showing at this moment, so the slip prints the
        // wait the patient was actually told rather than one recomputed after
        // their own token joined the queue.
        waitShown: waitPreview?.minutes ?? null,
      };

      /*
        Online first, offline as the fallback — not a mode the user selects.

        If the server answers, nothing changes. If it does not, the token is
        issued from a number this machine already leased, printed
        immediately, and queued for delivery. The patient sees an ordinary
        token either way; the only difference is where the number came from.
      */
      /*
        A dropped connection makes the server action THROW ("Failed to
        fetch"), it does not resolve with { ok: false }. Catching is
        therefore the actual offline signal — checking res.ok alone never
        reaches the fallback, which is how the first version of this silently
        did nothing when the cable was pulled.
      */
      let res: ActionResult<TokenReceipt> | null = null;
      try {
        res = await issueToken(payload);
      } catch {
        res = null; // unreachable server — fall through to the offline path
      }

      if (res?.ok) {
        setReceipt(res.data);
        return;
      }

      // A validation failure is not an outage: report it rather than
      // burning a leased number on a token the server already rejected.
      if (res && !res.ok && !/could not|failed/i.test(res.error)) {
        setError(res.error);
        return;
      }

      const offline = await issueOffline(payload, {
        seriesCode: active?.code ?? "",
        seriesLabel: active?.label ?? "",
        isEmergency: emergency,
        doctorName: doctor?.name ?? null,
        doctorRoom: doctor?.room ?? null,
        tier: tier ?? "NEW",
        services: picked,
      });

      if (offline.ok) setReceipt(offline.data);
      else setError(offline.error ?? res?.error ?? "Could not issue the token.");
    });
    // applyPatient is stable enough for this closure; deps kept explicit.
  }, [
    form, forceNew, seriesId, fee, staffId, picked, doctorId, waitOverride,
    waitPreview,
    // Read only on the offline branch, but genuinely read — leaving them out
    // would let a stale doctor or series end up on a queued slip.
    active?.code, active?.label, emergency, doctor?.name, doctor?.room, tier,
  ]);

  // F2 issues from anywhere — the expert path never needs the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        if (!pending) submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit, pending]);

  function applyPatient(p: PatientWithTier) {
    setForm({
      patientId: p.id,
      name: p.name,
      phone: p.phone,
      gender: p.gender,
      age: p.age_years == null ? "" : String(p.age_years),
      address: p.address,
    });
    setTier(p.tier);
    setLastVisit(`${p.visit_count} visit${p.visit_count === 1 ? "" : "s"} in the last year`);
    setMatches([]);
    setForceNew(false);
    setError(null);
    setSummary(null);
    setSelectedMrn(p.mrn);

    /*
      The summary loads after the patient is already applied, not before. The
      form must not sit blank waiting on a second round trip while the patient
      stands at the counter — the details are the urgent part, the history is
      the nice part.
    */
    startTransition(async () => {
      const s = await getPatientSummary(p.id).catch(() => null);
      if (!s) return;
      setSummary(s);
      /*
        Pre-select the doctor they usually see. Only when reception has not
        already chosen one — an explicit choice always outranks a guess.
      */
      setDoctorId((current) => {
        if (current !== null) return current;
        if (s.usual_doctor_id == null) return current;
        /*
          Guard against a doctor who has since been deactivated: they are not
          in the picker, so selecting them would leave an invisible selection.

          Compared with Number() on both sides because these ids are bigints
          and arrive from the server as strings; "1" === 1 is false, and a
          strict compare here silently disables the whole pre-select.
        */
        const match = doctors.find(
          (d) => Number(d.id) === Number(s.usual_doctor_id),
        );
        return match ? match.id : current;
      });
    });
  }

  function runLookup(raw: string) {
    const q = raw.trim();
    if (!q) return;
    startTransition(async () => {
      const { kind, matches: found } = await findPatients(q);
      setQueryKind(kind);
      setMatches(found.length > 1 ? found : []);
      if (found.length === 1) {
        applyPatient(found[0]);
      } else if (found.length === 0) {
        setTier(null);
        setLastVisit(null);
        setSummary(null);
        /*
          Nothing found means this is a new patient. Seed whichever field the
          search was actually for — a phone search should not leave reception
          retyping the number they just typed — but never seed the phone from
          an MRN or a name search, which would write nonsense into the record.
        */
        if (kind === "PHONE") {
          setForm((f) => ({ ...f, phone: q, patientId: null }));
        }
        nameRef.current?.focus();
      }
    });
  }

  function reset() {
    setForm(EMPTY);
    setQuery("");
    setQueryKind(null);
    setSummary(null);
    setSelectedMrn(null);
    setWaitOverride(null);
    setWaitPreview(null);
    setTier(null);
    setLastVisit(null);
    setMatches([]);
    setForceNew(false);
    setFeeOverride(null);
    setPicked([]);
    setDoctorId(null);
    setError(null);
    setReceipt(null);
    phoneRef.current?.focus();
  }

  if (receipt) {
    return <IssuedView receipt={receipt} clinic={clinic} onNext={reset} />;
  }

  return (
    <div
      data-mode={emergency ? "emergency" : "normal"}
      className="mx-auto max-w-6xl px-5 py-5"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight">New Token</h1>
          <p className="text-sm text-muted">
            {new Date().toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
        </div>
        <CounterPicker staff={staff} staffId={staffId} onStaff={setStaffId} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---------------------------------------------------------- form */}
        <div className="grid content-start gap-4">
          {/* 1 — triage. Leads because it is known first and colours the rest. */}
          <section>
            <GroupLabel step={1}>Visit type</GroupLabel>
            <div className="grid grid-cols-2 gap-3">
              {series.map((s) => {
                const on = s.id === seriesId;
                const isEm = s.is_emergency;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      setSeriesId(s.id);
                      setFeeOverride(null);
                    }}
                    className={`group relative flex items-center gap-3 rounded-[var(--r)]
                      border-2 p-3.5 text-left transition-all duration-100
                      active:scale-[0.99]
                      ${
                        on
                          ? isEm
                            ? "border-[var(--danger)] bg-[var(--danger-soft)] shadow-[var(--shadow-lg)]"
                            : "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[var(--shadow-lg)]"
                          : "border-[var(--line)] bg-surface hover:border-[var(--hover-line)] hover:bg-[var(--hover)] hover:shadow-[var(--shadow-lg)]"
                      }`}
                  >
                    {/* A tick, so selection is never colour-only. */}
                    {on && (
                      <span
                        className={`absolute right-2.5 top-2.5 flex h-5 w-5 items-center
                          justify-center rounded-full text-white ${
                            isEm ? "bg-[var(--danger)]" : "bg-[var(--accent)]"
                          }`}
                        aria-hidden
                      >
                        <IconCheck className="h-3 w-3" />
                      </span>
                    )}
                    <span
                      className={`flex h-11 w-11 shrink-0 items-center justify-center
                        rounded-[10px] transition-colors ${
                          on
                            ? isEm
                              ? "bg-[var(--danger)] text-white"
                              : "bg-[var(--accent)] text-white"
                            : "bg-sunken text-muted group-hover:text-[var(--ink-2)]"
                        }`}
                      aria-hidden
                    >
                      {isEm ? (
                        <IconAmbulance className="h-6 w-6" />
                      ) : (
                        <IconStethoscope className="h-6 w-6" />
                      )}
                    </span>
                    <span className="min-w-0">
                      {/*
                        Wraps rather than truncates: this is the visit type,
                        and it sets the fee. "Normal ..." on a phone hides the
                        one word that distinguishes it from Emergency, which
                        is a three-times price difference — not something to
                        clip for the sake of a single line.
                      */}
                      <span
                        className={`block text-[15px] font-bold leading-tight ${
                          on ? (isEm ? "text-[var(--danger)]" : "text-[var(--accent)]") : ""
                        }`}
                      >
                        {s.label}
                      </span>
                      <span className="tnum block text-sm text-muted">
                        {s.code} · Rs. {Number(s.base_fee).toFixed(0)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 2 — which doctor. Required: the token has to say where the
              patient is going, and reception knows this right after triage. */}
          <section>
            <GroupLabel step={2} hint="required">
              Doctor
            </GroupLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              {doctors.map((d) => {
                const on = d.id === doctorId;
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDoctorId(on ? null : d.id)}
                    className={`relative flex items-center gap-3 rounded-[var(--r)] border-2
                      p-3 text-left transition-all duration-100 active:scale-[0.99]
                      ${
                        on
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[var(--shadow-lg)]"
                          : "border-[var(--line)] bg-surface hover:border-[var(--hover-line)] hover:bg-[var(--hover)] hover:shadow-[var(--shadow)]"
                      }`}
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                        text-[13px] font-bold ${
                          on
                            ? "bg-[var(--accent)] text-white"
                            : "bg-sunken text-muted"
                        }`}
                      aria-hidden
                    >
                      {initials(d.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm font-bold ${
                          on ? "text-[var(--accent)]" : ""
                        }`}
                      >
                        {d.name}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {d.speciality}
                        {d.room ? ` · ${d.room}` : ""}
                      </span>
                    </span>
                    {on && (
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full
                          bg-[var(--accent)] text-white"
                        aria-hidden
                      >
                        <IconCheck className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {/*
              The wait, shown BEFORE the slip is printed rather than
              discovered on it, and editable — the estimate cannot know that
              the doctor just told reception they need forty minutes.

              Only once a doctor is chosen, because the queue it describes is
              that doctor's queue.
            */}
            {doctorId !== null && waitPreview && (
              <Card className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 p-3.5">
                <span className="text-sm font-medium text-muted">
                  Quoted wait
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    value={waitOverride ?? String(waitPreview.minutes)}
                    inputMode="numeric"
                    aria-label="Quoted wait in minutes"
                    onChange={(e) =>
                      setWaitOverride(e.target.value.replace(/[^\d]/g, ""))
                    }
                    className="tnum h-11 w-20 text-lg font-bold"
                  />
                  <span className="text-sm text-muted">min</span>
                </div>

                {/*
                  The range as the slip will actually print it. Reception used
                  to read "7" here and then hand over a slip saying "7-17 min";
                  two different-looking numbers for the same wait is what makes
                  a patient think they were told something else.
                */}
                <span className="tnum text-sm text-muted">
                  prints as{" "}
                  <span className="font-semibold text-[var(--ink-2)]">
                    {quotedWait}-{quotedWait + 10} min
                  </span>
                </span>

                {waitOverride === null ? (
                  <Badge tone="neutral">auto</Badge>
                ) : (
                  <button
                    type="button"
                    onClick={() => setWaitOverride(null)}
                    className="text-sm font-semibold text-[var(--accent)] underline"
                  >
                    Reset to {waitPreview.minutes}
                  </button>
                )}

                {/*
                  The reason the number is large. An unexplained jump from 12
                  to 45 minutes is what reception gets shouted at for; the
                  same number with "Namaz · back in 12 min" beside it is
                  something they can repeat to the patient.
                */}
                {waitPreview.state === "ON_BREAK" && (
                  <span className="flex items-center gap-1.5 rounded-[var(--r-sm)]
                    bg-[var(--gold-soft)] px-2.5 py-1 text-sm font-semibold
                    text-[var(--gold)]">
                    {waitPreview.breakReason || "On a break"}
                    {waitPreview.breakMinutesLeft > 0 &&
                      ` · back in ${waitPreview.breakMinutesLeft} min`}
                  </span>
                )}
                {waitPreview.state === "FINISHED" && (
                  <span className="rounded-[var(--r-sm)] bg-[var(--danger-soft)]
                    px-2.5 py-1 text-sm font-semibold text-[var(--danger)]">
                    Finished for today
                  </span>
                )}
              </Card>
            )}
          </section>

          {/* 3 — who. Phone first: most patients are returning. */}
          <section>
            <GroupLabel step={3}>Patient</GroupLabel>
            <Card className="grid gap-3.5 p-4">
              {/*
                One box, three kinds of input. Reception should never have to
                pick a search mode first: that is a keystroke on every patient
                and the wrong mode under pressure.
              */}
              <Field
                label="Find patient"
                htmlFor="patient-search"
                hint={
                  queryKind
                    ? `searched by ${queryKind.toLowerCase()}`
                    : "MRN, phone or name — press Enter"
                }
              >
                <div className="flex gap-2">
                  <input
                    id="patient-search"
                    ref={phoneRef}
                    value={query}
                    autoComplete="off"
                    /*
                      Built from the clinic's real prefix rather than hardcoded,
                      so changing it stays the one-row setting 0018 designed it
                      to be instead of becoming a deploy.
                    */
                    placeholder={`${clinic.mrn_prefix}-260825-0417  ·  03xx-xxxxxxx  ·  name`}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setQueryKind(null);
                      // Typing a new search abandons the previously chosen
                      // patient: silently keeping the old patientId is how a
                      // token gets issued against the wrong person.
                      setForm((f) => ({ ...f, patientId: null }));
                      setTier(null);
                      setLastVisit(null);
                      setSummary(null);
                      setSelectedMrn(null);
                      setForceNew(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        runLookup(query);
                      }
                    }}
                    className="text-[15px]"
                  />
                  <Button
                    onClick={() => runLookup(query)}
                    disabled={pending || query.trim().length < 3}
                    className="shrink-0 px-5"
                  >
                    <IconSearch className="h-[18px] w-[18px]" />
                    Search
                  </Button>
                </div>
              </Field>

              {/*
                Phone is now its own field. It used to double as the search
                box, which meant an MRN or a name search wrote itself into the
                patient's phone column.
              */}
              <Field label="Phone number" htmlFor="phone">
                <input
                  id="phone"
                  value={form.phone}
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="03xx-xxxxxxx"
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="tnum text-[15px]"
                />
              </Field>

              {/* Recognition banner — the payoff of the lookup, stated plainly. */}
              {form.patientId && (
                <div className="animate-rise flex flex-wrap items-center gap-2 rounded-[var(--r-sm)] bg-[var(--ok-soft)] px-3 py-2">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--ok)]">
                    <IconCheck className="h-4 w-4" />
                    Known patient
                  </span>
                  {lastVisit && (
                    <span className="text-sm text-[var(--ok)] opacity-80">
                      {lastVisit}
                    </span>
                  )}
                  {tier && tier !== "NEW" && (
                    <Badge tone="gold">
                      <IconStar className="h-3 w-3" />
                      {TIER_LABEL[tier]}
                    </Badge>
                  )}
                </div>
              )}

              {form.patientId && summary && (
                <PatientHistory summary={summary} mrn={selectedMrn} />
              )}

              {matches.length > 1 && (
                <div className="animate-rise overflow-hidden rounded-[var(--r-sm)] border border-[var(--line-strong)]">
                  {matches.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => applyPatient(m)}
                      className="flex w-full items-center justify-between gap-3 border-b
                        border-[var(--line)] px-3.5 py-2.5 text-left last:border-0
                        hover:bg-[var(--hover)]"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{m.name}</span>
                        {/* Gender and age are what actually separate two
                            family members on one number; the MRN alone does
                            not tell reception which one is standing there. */}
                        <span className="tnum text-xs text-muted">
                          {m.mrn} · {m.gender.charAt(0)}
                          {m.age_years != null && ` ${m.age_years}`}
                        </span>
                      </span>
                      <span className="tnum shrink-0 text-xs text-muted">
                        {m.visit_count} visits
                      </span>
                    </button>
                  ))}
                  {/* Families share one number — registering a genuinely new
                      person must never be a dead end. */}
                  <button
                    type="button"
                    onClick={() => {
                      setForceNew(true);
                      setMatches([]);
                      setError(null);
                      setForm((f) => ({ ...f, patientId: null, name: "" }));
                      nameRef.current?.focus();
                    }}
                    className="flex w-full items-center gap-1.5 bg-sunken px-3.5 py-2.5
                      text-left text-sm font-semibold text-[var(--accent)] hover:bg-[var(--hover)]"
                  >
                    <IconPlus className="h-4 w-4" />
                    Someone else on this number
                  </button>
                </div>
              )}

              {forceNew && (
                <p className="animate-rise flex items-center gap-2 rounded-[var(--r-sm)] bg-sunken px-3 py-2 text-sm">
                  Registering a <strong>new</strong> patient on this number.
                  <button
                    type="button"
                    onClick={() => setForceNew(false)}
                    className="ml-auto font-semibold text-[var(--accent)] underline"
                  >
                    Undo
                  </button>
                </p>
              )}

              <Field label="Full name" htmlFor="name" required>
                <input
                  id="name"
                  ref={nameRef}
                  value={form.name}
                  autoComplete="off"
                  placeholder="Patient's full name"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="text-[15px] font-medium"
                />
              </Field>

              {/*
                Gender and age share a row only when there is room for both.

                A fixed two-column track squeezed three gender buttons into
                ~59px each on a phone, which is below the size a thumb hits
                reliably and forced "Female" to wrap. Age is a three-character
                field, so it drops below rather than stealing width from the
                choice that is pressed far more often.
              */}
              <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_110px]">
                <Field label="Gender" required>
                  <Segmented
                    label="Gender"
                    size="lg"
                    value={form.gender || null}
                    onChange={(g) => setForm({ ...form, gender: g })}
                    options={[
                      { value: "MALE" as Gender, label: "Male" },
                      { value: "FEMALE" as Gender, label: "Female" },
                      { value: "OTHER" as Gender, label: "Other" },
                    ]}
                  />
                </Field>
                <Field label="Age" htmlFor="age" hint="yrs">
                  <input
                    id="age"
                    value={form.age}
                    inputMode="numeric"
                    placeholder="—"
                    onChange={(e) =>
                      setForm({ ...form, age: e.target.value.replace(/\D/g, "") })
                    }
                    className="tnum h-11 text-center text-[15px]"
                  />
                </Field>
              </div>
            </Card>
          </section>

          {/* 4 — labs at the counter. Optional, so it is collapsed until
              needed: most tokens are a plain consultation and the extra
              choice would tax every one of them. */}
          <section>
            <GroupLabel step={4} hint="optional">
              Lab tests &amp; services
            </GroupLabel>
            <LabPicker
              services={services}
              picked={picked}
              onToggle={(s) =>
                setPicked((cur) =>
                  cur.some((c) => c.id === s.id)
                    ? cur.filter((c) => c.id !== s.id)
                    : [...cur, s],
                )
              }
            />
          </section>

          {/* 5 — money. Pre-filled; usually just confirmed. */}
          <section>
            <GroupLabel step={5}>Fee</GroupLabel>
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-muted">Rs.</span>
                  <input
                    value={fee}
                    inputMode="decimal"
                    aria-label="Fee collected"
                    onChange={(e) =>
                      setFeeOverride(e.target.value.replace(/[^\d.]/g, ""))
                    }
                    className="tnum h-12 w-32 text-xl font-bold"
                  />
                </div>
                <span className="text-sm text-muted">
                  {active?.label ?? "Visit"} fee
                </span>
                {feeOverride !== null && active && (
                  <button
                    type="button"
                    onClick={() => setFeeOverride(null)}
                    className="text-sm font-semibold text-[var(--accent)] underline"
                  >
                    Reset to {Number(active.base_fee).toFixed(0)}
                  </button>
                )}
              </div>

              {picked.length > 0 && (
                <div className="mt-3.5 border-t border-[var(--line)] pt-3">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted">
                      {picked.length} lab item{picked.length === 1 ? "" : "s"}
                    </span>
                    <span className="tnum font-medium">
                      Rs. {labsTotal.toFixed(0)}
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="font-bold">Total to collect</span>
                    <span className="tnum text-2xl font-bold leading-none">
                      Rs. {grandTotal.toFixed(0)}
                    </span>
                  </div>
                </div>
              )}
            </Card>
          </section>

          {error && <Alert>{error}</Alert>}
        </div>

        {/* ------------------------------------------------- live slip panel */}
        <aside className="lg:sticky lg:top-5 lg:self-start">
          <GroupLabel>Slip preview</GroupLabel>
          <Card className="overflow-hidden">
            <div className="bg-sunken p-4">
              <SlipPreview
                clinicName={clinic.name}
                seriesLabel={active?.label ?? ""}
                code={active?.code ?? ""}
                emergency={emergency}
                name={form.name}
                gender={form.gender}
                age={form.age}
                doctor={doctor}
                lines={[
                  { name: `${active?.label ?? "Visit"} Fee`, amount: fee || "0" },
                  ...picked.map((p) => ({
                    name: p.name,
                    amount: Number(p.price).toFixed(0),
                  })),
                ]}
                total={grandTotal.toFixed(0)}
                tier={tier}
              />
            </div>

            <div className="border-t border-[var(--line)] p-3">
              <Button
                variant="primary"
                size="xl"
                onClick={submit}
                disabled={pending || !ready}
                className="w-full"
              >
                {pending ? "Issuing…" : "Issue Token & Print"}
              </Button>
              <p className="mt-2 text-center text-xs text-muted">
                {ready ? (
                  <>
                    or press <kbd>F2</kbd>
                  </>
                ) : (
                  "Enter a name and gender to continue"
                )}
              </p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/**
 * Optional lab/service picker for the counter.
 *
 * Collapsed by default: the overwhelming majority of tokens are a plain
 * consultation, and an always-open catalogue would tax every one of them with
 * a choice they do not need to make. Opening it is one click; what has been
 * chosen stays visible as chips even when it is closed again, so the decision
 * is never hidden from the person collecting the money.
 */
function LabPicker({
  services,
  picked,
  onToggle,
}: {
  services: ServiceRow[];
  picked: ServiceRow[];
  onToggle: (s: ServiceRow) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const categories = Array.from(new Set(services.map((s) => s.category)));
  const [tab, setTab] = useState(categories[0] ?? "LAB");

  // Search spans every category: staff know the test name, not the bucket.
  const visible = q.trim()
    ? services.filter((s) =>
        (s.name + " " + s.code).toLowerCase().includes(q.trim().toLowerCase()),
      )
    : services.filter((s) => s.category === tab);

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--hover)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-sunken text-muted">
          <IconFlask className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {picked.length === 0
              ? "Add lab tests or services"
              : `${picked.length} item${picked.length === 1 ? "" : "s"} added`}
          </span>
          <span className="block text-xs text-muted">
            Billed and paid together with the visit fee
          </span>
        </span>
        <IconChevron
          className={`h-5 w-5 shrink-0 text-muted transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Chosen items stay visible whether or not the catalogue is open. */}
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-[var(--line)] px-4 py-3">
          {picked.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onToggle(s)}
              aria-label={`Remove ${s.name}`}
              className="tnum inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-soft)]
                px-3 py-1.5 text-[13px] font-semibold text-[var(--accent)]
                transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
              style={{ minHeight: 32 }}
            >
              {s.name}
              <span className="opacity-70">Rs. {Number(s.price).toFixed(0)}</span>
              <IconCross className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="border-t border-[var(--line)]">
          <div className="p-3">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search all tests and services…"
                className="!pl-10"
              />
            </div>

            {!q.trim() && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setTab(c)}
                    aria-pressed={tab === c}
                    className={`h-9 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
                      tab === c
                        ? "bg-[var(--accent)] text-white"
                        : "bg-sunken text-[var(--ink-2)] hover:bg-[var(--surface)] hover:text-[var(--accent)] hover:shadow-[var(--shadow)]"
                    }`}
                    style={{ minHeight: 36 }}
                  >
                    {c.charAt(0) + c.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          <ul className="max-h-[260px] overflow-y-auto border-t border-[var(--line)]">
            {visible.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted">
                No matching test or service.
              </li>
            )}
            {visible.map((s) => {
              const on = picked.some((p) => p.id === s.id);
              return (
                <li key={s.id} className="border-b border-[var(--line)] last:border-0">
                  <button
                    type="button"
                    onClick={() => onToggle(s)}
                    aria-pressed={on}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left
                      transition-colors ${on ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--hover)]"}`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px]
                        border-2 transition-colors ${
                          on
                            ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                            : "border-[var(--line-strong)]"
                        }`}
                      aria-hidden
                    >
                      {on && <IconCheck className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {s.name}
                      </span>
                      <span className="tnum text-xs text-muted">
                        {s.code}
                        {q.trim()
                          ? ` · ${s.category.charAt(0)}${s.category.slice(1).toLowerCase()}`
                          : ""}
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-sm font-bold">
                      Rs. {Number(s.price).toFixed(0)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** A quiet facsimile of the paper slip, filling in as the form is typed. */
function SlipPreview({
  clinicName,
  seriesLabel,
  code,
  emergency,
  name,
  gender,
  age,
  doctor,
  lines,
  total,
  tier,
}: {
  clinicName: string;
  seriesLabel: string;
  code: string;
  emergency: boolean;
  name: string;
  gender: string;
  age: string;
  doctor: Doctor | null;
  lines: { name: string; amount: string }[];
  total: string;
  tier: string | null;
}) {
  return (
    <div className="mx-auto max-w-[240px] rounded-[6px] bg-white px-4 py-4 font-mono text-[11px] leading-relaxed text-black shadow-[var(--shadow-lg)]">
      <p className="truncate text-center text-[12px] font-bold">{clinicName}</p>
      <div className="my-2 border-t border-dashed border-black/40" />

      <p
        className={`border-2 border-black py-1 text-center text-[11px] font-bold ${
          emergency ? "bg-black text-white" : ""
        }`}
      >
        {emergency ? "** EMERGENCY **" : seriesLabel.toUpperCase() || "—"}
      </p>

      <p className="mt-2 text-center text-[9px] tracking-widest">TOKEN NUMBER</p>
      {/* The number is unknown until issue — shown as the real format so the
          slot is recognisable, not as a fake number that could be misread. */}
      <p className="tnum text-center text-[30px] font-bold leading-tight">
        {code || "—"}-
        <span className="opacity-25">•••••</span>
      </p>

      <div className="my-2 border-t border-dashed border-black/40" />

      <Line k="Name" v={name || "—"} />
      <Line
        k="Doctor"
        v={doctor ? `${doctor.name}${doctor.room ? ` · ${doctor.room}` : ""}` : "—"}
      />
      <Line
        k="Gender"
        v={
          gender
            ? gender.charAt(0) + gender.slice(1).toLowerCase() + (age ? ` / ${age}y` : "")
            : "—"
        }
      />
      <Line
        k="Date"
        v={new Date().toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })}
      />
      {tier && tier !== "NEW" && <Line k="Patient" v={tier} />}

      <div className="my-2 border-t border-dashed border-black/40" />

      {lines.map((l, i) => (
        <div key={i} className="flex justify-between gap-2">
          <span className="truncate opacity-80">{l.name}</span>
          <span className="tnum shrink-0">{l.amount}</span>
        </div>
      ))}

      <div className="my-1.5 border-t border-black/70" />
      <div className="flex justify-between font-bold">
        <span>TOTAL</span>
        <span className="tnum">Rs. {total}</span>
      </div>
    </div>
  );
}

/** "Dr. Ahmed Raza" -> "AR" — a compact stand-in for a photo. */
function initials(name: string) {
  return name
    .replace(/^Dr\.?\s*/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="shrink-0 opacity-70">{k}</span>
      <span className="truncate text-right font-semibold">{v}</span>
    </div>
  );
}

/**
 * Success state. The number is the whole point, so it dominates the screen at
 * a size readable across the counter, and the next action is one key away.
 */
function IssuedView({
  receipt,
  clinic,
  onNext,
}: {
  receipt: TokenReceipt;
  clinic: ClinicSetting;
  onNext: () => void;
}) {
  const [printState, setPrintState] = useState<PrintState | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);

  /*
    Print once, automatically. usePrinter picks the route: the serial printer
    on the server's COM port, else WebUSB, else the browser dialog.

    Two traps this avoids, both of which silently printed nothing:
     * `printer` is a new object every render, so depending on it re-ran the
       effect and the cleanup cancelled the pending frame.
     * React Strict Mode mounts effects twice in development. A plain
       "already fired" ref latched on the FIRST (discarded) mount, so the real
       mount skipped printing entirely.

    So: no cancellation on cleanup, and the guard is keyed to the receipt so a
    genuinely new token always prints exactly once.
  */
  /*
    The slip is NOT printed from here.

    Issuing queues the token; print-agent/agent.mjs, on the PC the printer is
    attached to, picks it up and prints it. Printing from the issuing device
    as well would put two identical slips on the roll for every token issued
    at reception, and would still leave a tablet unable to print at all.

    "Print again" below stays, for the case where the paper jammed or the
    patient lost their slip and someone is standing at the counter asking.

    What is watched instead is the queue itself, so reception sees the slip
    reach paper — or sees why it did not, while the patient is still at the
    counter rather than after they have left.
  */
  useEffect(() => {
    let live = true;

    /*
      Polled throughout, not stopped once the slip lands.

      Stopping at PRINTED looked tidy and was wrong: "Print again" puts the
      token back to PENDING, and a stopped poll would leave the screen saying
      "printed" while the second slip was still on its way — or never came.
      This screen is only up for one patient, so the cost is a handful of
      cheap reads.
    */
    const poll = async () => {
      const state = await getPrintState(receipt.unique_id).catch(() => null);
      if (!live || !state) return;
      setPrintState(state.status);
      setPrintError(state.error);
    };

    const timer = window.setInterval(poll, 1200);
    void poll();
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [receipt.unique_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext]);

  return (
    <>
      <div
        data-mode={receipt.is_emergency ? "emergency" : "normal"}
        className="no-print mx-auto flex max-w-2xl flex-col items-center px-5 py-10 text-center"
      >
        {/* The token exists either way — that is never in doubt once this
            screen renders. Only the paper is still in question, so a print
            failure colours the badge without implying the token is lost. */}
        <Badge tone={printState === "FAILED" ? "danger" : "ok"}>
          <IconCheck className="h-3.5 w-3.5" />
          Token issued
          {printState === "PRINTED"
            ? " · printed"
            : printState === "FAILED"
              ? " · NOT printed"
              : " · printing"}
        </Badge>

        {printState === "FAILED" && (
          <p className="mt-2 max-w-sm text-xs text-[var(--danger)]">
            {printError ?? "The printer refused the slip."} Use Print again
            once it is ready.
          </p>
        )}

        <p
          className="tnum animate-pop my-3 text-[92px] font-black leading-none tracking-tight
            text-[var(--accent)]"
        >
          {receipt.display_no}
        </p>

        <p className="text-xl font-semibold">{receipt.patient_name}</p>
        {receipt.doctor_name && (
          <p className="mt-1 text-base font-semibold text-[var(--accent)]">
            → {receipt.doctor_name}
            {receipt.doctor_room ? ` · ${receipt.doctor_room}` : ""}
          </p>
        )}
        <p className="tnum mt-0.5 text-sm text-muted">
          {receipt.mrn} · {receipt.gender.charAt(0)}
          {receipt.gender.slice(1).toLowerCase()}
          {receipt.age_years != null ? ` · ${receipt.age_years}y` : ""}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Badge tone={receipt.is_emergency ? "danger" : "accent"}>
            {receipt.is_emergency && <IconAmbulance className="h-3.5 w-3.5" />}
            {receipt.is_emergency ? "Emergency" : receipt.series_label}
          </Badge>
          <Badge tone="ok">Rs. {receipt.total} paid</Badge>
          {receipt.lines.length > 1 && (
            <Badge tone="accent">
              <IconFlask className="h-3.5 w-3.5" />
              {receipt.lines.length - 1} lab item
              {receipt.lines.length === 2 ? "" : "s"}
            </Badge>
          )}
          {receipt.tier !== "NEW" && (
            <Badge tone="gold">
              <IconStar className="h-3 w-3" />
              {TIER_LABEL[receipt.tier]}
            </Badge>
          )}
        </div>

        <div className="mt-9 grid w-full max-w-sm gap-2.5">
          <Button variant="primary" size="xl" onClick={onNext}>
            Next Patient
          </Button>
          {/* Queues rather than printing from here: this device may be a
              tablet with no printer, and the agent at the counter is the only
              thing that can reach one. The badge above then follows it to
              paper, exactly as it does for the first print. */}
          <Button
            size="lg"
            onClick={() => {
              setPrintState("PENDING");
              setPrintError(null);
              void reprintToken(receipt.unique_id).then((r) => {
                if (!r.ok) {
                  setPrintState("FAILED");
                  setPrintError(r.error);
                }
              });
            }}
            disabled={printState === "PENDING" || printState === "CLAIMED"}
          >
            <IconPrinter className="h-[18px] w-[18px]" />
            {printState === "PENDING" || printState === "CLAIMED"
              ? "Printing…"
              : "Print again"}
          </Button>
          <p className="text-xs text-muted">
            press <kbd>Enter</kbd> for the next patient
          </p>
        </div>
      </div>

      {createPortal(
        <div id="print-root">
          <TokenSlip receipt={receipt} clinic={clinic} />
        </div>,
        document.body,
      )}
    </>
  );
}

function CounterPicker({
  staff,
  staffId,
  onStaff,
}: {
  staff: Staff[];
  staffId: number | null;
  onStaff: (id: number) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-2 text-sm text-muted">
      <span className="hidden sm:inline">Counter</span>
      <select
        value={staffId ?? ""}
        onChange={(e) => onStaff(Number(e.target.value))}
        className="h-10 w-auto min-w-[130px] font-medium"
      >
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/*
  The recognition payoff. A returning patient should be greeted with what the
  clinic already knows — "Dr. Khan again?" — instead of being asked the same
  questions as a stranger.

  Deliberately compact: this sits above the fold on the reception screen, and
  a card that pushes the Issue button off-screen would cost more than the
  history is worth. Three visits, not ten.
*/
function PatientHistory({
  summary,
  mrn,
}: {
  summary: PatientSummary;
  mrn: string | null;
}) {
  return (
    <div className="animate-rise rounded-[var(--r-sm)] border border-[var(--line)] bg-sunken">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[var(--line)] px-3.5 py-2.5">
        {mrn && <span className="tnum text-sm font-semibold">{mrn}</span>}
        <span className="tnum text-xs text-muted">
          {summary.visit_count} visit{summary.visit_count === 1 ? "" : "s"}
        </span>
        {summary.last_seen && (
          <span className="text-xs text-muted">
            last seen {formatDay(summary.last_seen)} ({sinceDays(summary.last_seen)})
          </span>
        )}
        {summary.usual_doctor_name && (
          <span className="text-xs text-muted">
            usually {summary.usual_doctor_name}
          </span>
        )}
      </div>

      {summary.recent.length > 0 && (
        <ul className="px-3.5 py-2">
          {summary.recent.map((v) => (
            <li
              key={v.visit_id}
              className="flex items-baseline justify-between gap-3 py-0.5 text-xs"
            >
              <span className="tnum shrink-0 text-muted">
                {formatDay(v.visit_date)}
              </span>
              <span className="min-w-0 flex-1 truncate text-right">
                {v.doctor_name ?? "—"}
                <span className="text-muted"> · {v.series_label}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Dates come from Postgres as YYYY-MM-DD. Parsed by parts, never through
// new Date("YYYY-MM-DD"), which is treated as UTC and renders as the previous
// day for every clinic east of Greenwich — including this one.
function parseDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDay(iso: string): string {
  return parseDay(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function sinceDays(iso: string): string {
  const then = parseDay(iso);
  const now = new Date();
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      then.getTime()) /
      86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
