"use client";

import { useState, useTransition } from "react";
import {
  addStaff,
  changeAdminPin,
  saveClinic,
  saveDoctor,
  saveService,
  updateSeries,
  type AdminService,
} from "@/app/actions/admin";
import type { Analytics } from "@/app/actions/analytics";
import { AnalyticsScreen } from "@/components/Analytics";
import { PrintSetup } from "@/components/PrintSetup";
import { WaitAccuracy } from "@/components/WaitAccuracy";
import { DoctorPins } from "@/components/DoctorPins";
import { Alert, Badge, Button, Card, Empty, Field } from "@/components/ui";
import {
  IconAmbulance,
  IconPlus,
  IconStethoscope,
} from "@/components/icons";
import type { ClinicSetting, Doctor, Staff, TokenSeries } from "@/lib/types";

const CATEGORIES = ["CONSULT", "LAB", "RADIOLOGY", "PROCEDURE", "OTHER"] as const;
type Category = (typeof CATEGORIES)[number];

const TABS = [
  { id: "analytics", label: "Analytics" },
  { id: "doctors", label: "Doctors" },
  { id: "accuracy", label: "Wait accuracy" },
  { id: "series", label: "Token series" },
  { id: "catalogue", label: "Lab & services" },
  { id: "clinic", label: "Clinic & receipt" },
  { id: "printer", label: "Printer" },
  { id: "staff", label: "Counter staff" },
] as const;

export function AdminScreen({
  series: initialSeries,
  services: initialServices,
  clinic: initialClinic,
  staff: initialStaff,
  doctors: initialDoctors,
  analytics,
  appUrl,
}: {
  series: TokenSeries[];
  services: AdminService[];
  clinic: ClinicSetting;
  staff: Staff[];
  doctors: Doctor[];
  analytics: Analytics;
  appUrl: string;
}) {
  // Analytics leads: the first question an owner opens this screen with is
  // "how are we doing?", not "what shall I reconfigure?".
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("analytics");
  const [series, setSeries] = useState(initialSeries);
  const [services, setServices] = useState(initialServices);
  const [clinic, setClinic] = useState(initialClinic);
  const [staff, setStaff] = useState(initialStaff);
  const [doctors, setDoctors] = useState(initialDoctors);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  // Analytics needs room for charts; the settings tabs read better narrow.
  const wide = tab === "analytics" || tab === "accuracy";

  return (
    <div className={`mx-auto px-5 py-5 ${wide ? "max-w-6xl" : "max-w-4xl"}`}>
      <h1 className="mb-4 text-[22px] font-bold tracking-tight">Admin</h1>

      <div className="mb-5 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setMsg(null);
            }}
            aria-pressed={tab === t.id}
            className={`h-10 rounded-full px-4 text-sm font-semibold transition-colors ${
              tab === t.id
                ? "bg-[var(--accent)] text-white shadow-[var(--shadow)]"
                : "bg-sunken text-[var(--ink-2)] hover:bg-white hover:text-[var(--accent)] hover:shadow-[var(--shadow)]"
            }`}
            style={{ minHeight: 40 }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="mb-4">
          <Alert tone={msg.ok ? "ok" : "danger"}>{msg.text}</Alert>
        </div>
      )}

      {tab === "analytics" && <AnalyticsScreen initial={analytics} />}

      {tab === "accuracy" && <WaitAccuracy />}

      {tab === "printer" && <PrintSetup appUrl={appUrl} clinic={clinic} />}

      {tab === "doctors" && (
        <DoctorsTab
          doctors={doctors}
          disabled={pending}
          onSave={(payload) =>
            start(async () => {
              const res = await saveDoctor(payload);
              if (res.ok) {
                setDoctors(res.data);
                setMsg({ ok: true, text: `Saved ${payload.name}.` });
              } else setMsg({ ok: false, text: res.error });
            })
          }
        />
      )}

      {tab === "series" && (
        <section className="grid gap-3">
          <Note>
            Renaming a prefix affects only tokens issued from now on. Today&apos;s
            count does not restart, and slips already printed keep the number
            they were printed with.
          </Note>
          {series.map((s) => (
            <SeriesCard
              key={s.id}
              series={s}
              disabled={pending}
              onSave={(payload) =>
                start(async () => {
                  const res = await updateSeries({ id: s.id, ...payload });
                  if (res.ok) {
                    setSeries(res.data);
                    setMsg({ ok: true, text: `Saved “${payload.label}”.` });
                  } else setMsg({ ok: false, text: res.error });
                })
              }
            />
          ))}
        </section>
      )}

      {tab === "catalogue" && (
        <CatalogueTab
          services={services}
          disabled={pending}
          onSave={(payload) =>
            start(async () => {
              const res = await saveService(payload);
              if (res.ok) {
                setServices(res.data);
                setMsg({ ok: true, text: `Saved “${payload.name}”.` });
              } else setMsg({ ok: false, text: res.error });
            })
          }
        />
      )}

      {tab === "clinic" && (
        <ClinicTab
          clinic={clinic}
          disabled={pending}
          onSave={(payload) =>
            start(async () => {
              const res = await saveClinic(payload);
              if (res.ok) {
                setClinic(res.data);
                setMsg({ ok: true, text: "Receipt header updated." });
              } else setMsg({ ok: false, text: res.error });
            })
          }
        />
      )}

      {tab === "staff" && (
        <StaffTab
          staff={staff}
          disabled={pending}
          onAdd={(name) =>
            start(async () => {
              const res = await addStaff(name);
              if (res.ok) {
                setStaff(res.data);
                setMsg({ ok: true, text: `Added ${name}.` });
              } else setMsg({ ok: false, text: res.error });
            })
          }
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- doctors */

function DoctorsTab({
  doctors,
  disabled,
  onSave,
}: {
  doctors: Doctor[];
  disabled: boolean;
  onSave: (p: {
    id: number | null;
    name: string;
    speciality: string;
    room: string;
    active: boolean;
  }) => void;
}) {
  const [editing, setEditing] = useState<Doctor | "new" | null>(null);

  return (
    <section>
      <Note>
        Reception must pick a doctor for every token, and the doctor and room
        are printed on the slip so the patient knows where to go. Turning a
        doctor off hides them from the counter without touching past visits.
      </Note>

      {editing ? (
        <div className="mt-3">
          <DoctorForm
            initial={editing === "new" ? null : editing}
            disabled={disabled}
            onCancel={() => setEditing(null)}
            onSave={(p) => {
              onSave(p);
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <button
          onClick={() => setEditing("new")}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[var(--r-lg)]
            border-2 border-dashed border-[var(--line-strong)] bg-surface py-3.5
            text-sm font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--hover)]"
        >
          <IconPlus className="h-[18px] w-[18px]" />
          Add doctor
        </button>
      )}

      <Card className="mt-4 overflow-hidden">
        {doctors.length === 0 ? (
          <Empty>No doctors yet. Add one to start issuing tokens.</Empty>
        ) : (
          <ul>
            {doctors.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-2.5 last:border-0"
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                    bg-sunken text-[13px] font-bold text-muted"
                  aria-hidden
                >
                  {d.name
                    .replace(/^Dr\.?\s*/i, "")
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((w) => w[0]?.toUpperCase() ?? "")
                    .join("")}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {d.name}
                    {!d.active && (
                      <span className="ml-2 text-xs font-normal text-muted">
                        hidden
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {d.speciality || "—"}
                    {d.room ? ` · ${d.room}` : ""}
                  </span>
                </span>
                <Button
                  onClick={() => setEditing(d)}
                  className="h-9 shrink-0 px-4 text-xs"
                  style={{ minHeight: 36 }}
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <DoctorPins />
    </section>
  );
}

function DoctorForm({
  initial,
  disabled,
  onCancel,
  onSave,
}: {
  initial: Doctor | null;
  disabled: boolean;
  onCancel: () => void;
  onSave: (p: {
    id: number | null;
    name: string;
    speciality: string;
    room: string;
    active: boolean;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [speciality, setSpeciality] = useState(initial?.speciality ?? "");
  const [room, setRoom] = useState(initial?.room ?? "");
  const [active, setActive] = useState(initial?.active ?? true);

  return (
    <Card className="border-2 border-[var(--accent)] p-4">
      <h3 className="mb-3 text-sm font-bold">
        {initial ? `Edit ${initial.name}` : "New doctor"}
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dr. Ahmed Raza"
          />
        </Field>
        <Field label="Speciality">
          <input
            value={speciality}
            onChange={(e) => setSpeciality(e.target.value)}
            placeholder="General Physician"
          />
        </Field>
        <Field label="Room" hint="printed on the slip">
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="Room 1"
          />
        </Field>
      </div>
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
        <Check
          checked={active}
          onChange={setActive}
          label="Available at the counter"
        />
        <div className="flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={disabled || !name.trim()}
            onClick={() =>
              onSave({ id: initial?.id ?? null, name, speciality, room, active })
            }
            className="px-7"
          >
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------- token series */

function SeriesCard({
  series,
  disabled,
  onSave,
}: {
  series: TokenSeries;
  disabled: boolean;
  onSave: (p: {
    code: string;
    label: string;
    baseFee: number;
    active: boolean;
  }) => void;
}) {
  const [code, setCode] = useState(series.code);
  const [label, setLabel] = useState(series.label);
  const [fee, setFee] = useState(String(Number(series.base_fee)));
  const [active, setActive] = useState(series.active);
  const em = series.is_emergency;

  return (
    <Card className="p-4">
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-[10px] ${
            em
              ? "bg-[var(--danger-soft)] text-[var(--danger)]"
              : "bg-[var(--accent-soft)] text-[var(--accent)]"
          }`}
          aria-hidden
        >
          {em ? (
            <IconAmbulance className="h-5 w-5" />
          ) : (
            <IconStethoscope className="h-5 w-5" />
          )}
        </span>
        <Badge tone={em ? "danger" : "accent"}>
          {em ? "Emergency" : "Normal"}
        </Badge>
        {/* Live preview — the whole point of this screen is "what will the
            slip say?", so it answers that while typing. */}
        <span className="tnum ml-auto rounded-[var(--r-sm)] bg-sunken px-2.5 py-1 font-mono text-sm font-bold">
          {code.toUpperCase() || "—"}-00001
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Prefix">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={10}
            className="font-mono font-semibold uppercase"
          />
        </Field>
        <Field label="Display name">
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Default fee" hint="Rs.">
          <input
            value={fee}
            inputMode="decimal"
            onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))}
            className="tnum"
          />
        </Field>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
        <Check
          checked={active}
          onChange={setActive}
          label="Available at the counter"
        />
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() => onSave({ code, label, baseFee: Number(fee || 0), active })}
          className="px-7"
        >
          Save
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ catalogue */

function CatalogueTab({
  services,
  disabled,
  onSave,
}: {
  services: AdminService[];
  disabled: boolean;
  onSave: (p: {
    id: number | null;
    code: string;
    name: string;
    category: Category;
    price: number;
    active: boolean;
  }) => void;
}) {
  const [editing, setEditing] = useState<AdminService | "new" | null>(null);
  const grouped = CATEGORIES.map((c) => ({
    category: c,
    rows: services.filter((s) => s.category === c),
  })).filter((g) => g.rows.length > 0);

  return (
    <section>
      <Note>
        Changing a price affects future bills only. Bills already issued keep
        the price they were charged at.
      </Note>

      {editing ? (
        <div className="mt-3">
          <ServiceForm
            initial={editing === "new" ? null : editing}
            disabled={disabled}
            onCancel={() => setEditing(null)}
            onSave={(p) => {
              onSave(p);
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <button
          onClick={() => setEditing("new")}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[var(--r-lg)]
            border-2 border-dashed border-[var(--line-strong)] bg-surface py-3.5
            text-sm font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--hover)]"
        >
          <IconPlus className="h-[18px] w-[18px]" />
          Add lab test or service
        </button>
      )}

      <div className="mt-4 grid gap-4">
        {grouped.map((g) => (
          <div key={g.category}>
            <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
              {titleCase(g.category)}
            </h2>
            <Card className="overflow-hidden">
              <ul>
                {g.rows.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-3 border-b border-[var(--line)]
                      px-4 py-2.5 last:border-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {s.name}
                        {!s.active && (
                          <span className="ml-2 text-xs font-normal text-muted">
                            hidden
                          </span>
                        )}
                      </span>
                      <span className="tnum text-xs text-muted">{s.code}</span>
                    </span>
                    <span className="tnum shrink-0 text-sm font-bold">
                      Rs. {Number(s.price).toFixed(0)}
                    </span>
                    <Button
                      onClick={() => setEditing(s)}
                      className="h-9 shrink-0 px-4 text-xs"
                      style={{ minHeight: 36 }}
                    >
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        ))}
      </div>
    </section>
  );
}

function ServiceForm({
  initial,
  disabled,
  onCancel,
  onSave,
}: {
  initial: AdminService | null;
  disabled: boolean;
  onCancel: () => void;
  onSave: (p: {
    id: number | null;
    code: string;
    name: string;
    category: Category;
    price: number;
    active: boolean;
  }) => void;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<Category>(
    (initial?.category as Category) ?? "LAB",
  );
  const [price, setPrice] = useState(initial ? String(Number(initial.price)) : "");
  const [active, setActive] = useState(initial?.active ?? true);

  return (
    <Card className="border-2 border-[var(--accent)] p-4">
      <h3 className="mb-3 text-sm font-bold">
        {initial ? `Edit “${initial.name}”` : "New test or service"}
      </h3>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Vitamin D Test"
          />
        </Field>
        <Field label="Code" required>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="LAB-VITD"
            className="font-mono uppercase"
          />
        </Field>
        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            className="h-11"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Price" hint="Rs.">
          <input
            value={price}
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
            className="tnum font-semibold"
          />
        </Field>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
        <Check
          checked={active}
          onChange={setActive}
          label="Show at the billing counter"
        />
        <div className="flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={disabled || !name.trim() || !code.trim()}
            onClick={() =>
              onSave({
                id: initial?.id ?? null,
                code,
                name,
                category,
                price: Number(price || 0),
                active,
              })
            }
            className="px-7"
          >
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- clinic */

function ClinicTab({
  clinic,
  disabled,
  onSave,
}: {
  clinic: ClinicSetting;
  disabled: boolean;
  onSave: (p: {
    name: string;
    address: string;
    phone: string;
    footerNote: string;
    paperWidth: number;
  }) => void;
}) {
  const [name, setName] = useState(clinic.name);
  const [address, setAddress] = useState(clinic.address);
  const [phone, setPhone] = useState(clinic.phone);
  const [footer, setFooter] = useState(clinic.footer_note);
  const [paper, setPaper] = useState(clinic.paper_width);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
      <Card className="grid content-start gap-3 p-4">
        <Field label="Clinic name" hint="printed on every slip" required>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Address">
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Footer note">
            <input
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Get well soon."
            />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-[var(--ink-2)]">
            Receipt paper width
          </legend>
          <div className="grid max-w-[240px] grid-cols-2 gap-1 rounded-[var(--r-sm)] bg-sunken p-1">
            {[58, 80].map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={paper === w}
                onClick={() => setPaper(w)}
                className={`h-10 rounded-[6px] text-sm font-semibold transition-all ${
                  paper === w
                    ? "bg-white text-[var(--accent)] shadow-[var(--shadow)]"
                    : "text-muted"
                }`}
                style={{ minHeight: 40 }}
              >
                {w}mm
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            80mm fits 48 characters per line; 58mm fits 32.
          </p>
        </fieldset>

        <Button
          variant="primary"
          size="lg"
          disabled={disabled}
          onClick={() =>
            onSave({ name, address, phone, footerNote: footer, paperWidth: paper })
          }
          className="mt-1 w-full"
        >
          Save
        </Button>
      </Card>

      {/* What the header will actually look like on paper. */}
      <aside>
        <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
          Slip header
        </h2>
        <Card className="bg-sunken p-4">
          <div className="mx-auto max-w-[210px] rounded-[6px] bg-white px-4 py-3 text-center font-mono text-[11px] text-black shadow-[var(--shadow-lg)]">
            <p className="truncate text-[12px] font-bold">{name || "Clinic"}</p>
            {address && <p className="truncate text-[9px]">{address}</p>}
            {phone && <p className="text-[9px]">Ph: {phone}</p>}
            <div className="my-2 border-t border-dashed border-black/40" />
            <p className="text-[9px] opacity-50">token details…</p>
            <div className="my-2 border-t border-dashed border-black/40" />
            {footer && <p className="text-[9px]">{footer}</p>}
          </div>
        </Card>
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- staff */

function StaffTab({
  staff,
  disabled,
  onAdd,
}: {
  staff: Staff[];
  disabled: boolean;
  onAdd: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    if (name.trim()) {
      onAdd(name.trim());
      setName("");
    }
  };

  return (
    <section>
      <Note>
        There is one shared login, so this list is only a “who is at the
        counter” picker. Whoever is selected is stamped on every token, payment
        and removal in the audit log.
      </Note>

      <div className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Name"
        />
        <Button
          variant="primary"
          disabled={disabled || !name.trim()}
          onClick={submit}
          className="shrink-0 px-6"
        >
          <IconPlus className="h-[18px] w-[18px]" />
          Add
        </Button>
      </div>

      <Card className="mt-3 overflow-hidden">
        {staff.length === 0 ? (
          <Empty>No counter staff yet.</Empty>
        ) : (
          <ul>
            {staff.map((s) => (
              <li
                key={s.id}
                className="border-b border-[var(--line)] px-4 py-3 text-sm font-semibold last:border-0"
              >
                {s.name}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <h2 className="mb-2 mt-6 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted">
        Admin PIN
      </h2>
      <PinChanger />
    </section>
  );
}

function PinChanger() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <Card className="p-4">
      <p className="mb-3 text-sm text-muted">
        Protects fees, prices and token prefixes. Reception should not know it.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Current PIN">
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={current}
            onChange={(e) => setCurrent(e.target.value.replace(/\D/g, ""))}
            className="tnum tracking-[0.3em]"
            placeholder="••••"
          />
        </Field>
        <Field label="New PIN" hint="4–6 digits">
          <input
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={next}
            onChange={(e) => setNext(e.target.value.replace(/\D/g, ""))}
            className="tnum tracking-[0.3em]"
            placeholder="••••"
          />
        </Field>
      </div>

      {msg && (
        <div className="mt-3">
          <Alert tone={msg.ok ? "ok" : "danger"}>{msg.text}</Alert>
        </div>
      )}

      <Button
        variant="primary"
        disabled={pending || current.length < 4 || next.length < 4}
        onClick={() =>
          start(async () => {
            const res = await changeAdminPin(current, next);
            if (res.ok) {
              setMsg({ ok: true, text: "PIN changed." });
              setCurrent("");
              setNext("");
            } else setMsg({ ok: false, text: res.error });
          })
        }
        className="mt-3.5 px-7"
      >
        Change PIN
      </Button>
    </Card>
  );
}

/* --------------------------------------------------------------- pieces */

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[var(--r-sm)] border border-[var(--line)] bg-sunken px-4 py-3 text-sm text-[var(--ink-2)]">
      {children}
    </p>
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="!h-[18px] !w-[18px] !min-h-0 accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
