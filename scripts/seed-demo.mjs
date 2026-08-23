// Generates a few weeks of plausible history so the analytics dashboard can
// be looked at and judged. Development only — never run against live data.
//
// Usage: node --env-file=.env.local scripts/seed-demo.mjs [days]
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const DAYS = Number(process.argv[2] ?? 45);
const sql = postgres(url, { max: 5, connection: { timezone: "Asia/Karachi" } });

const FIRST = ["Ahmed","Sara","Bilal","Nadia","Imran","Ayesha","Usman","Hina",
  "Fahad","Maryam","Kashif","Zainab","Tariq","Rabia","Junaid","Sana","Adnan",
  "Farah","Omar","Nida","Shahid","Amna","Waqas","Saima"];
const LAST = ["Khan","Malik","Sheikh","Iqbal","Raza","Hussain","Butt","Chaudhry",
  "Ansari","Qureshi","Siddiqui","Baig"];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;

try {
  const series = await sql`select id, code, base_fee, is_emergency from token_series where active`;
  const doctors = await sql`select id from doctor where active`;
  const staff = await sql`select id from staff where active`;
  const services = await sql`select id, name, price, category from service where active`;

  if (doctors.length === 0) throw new Error("No doctors — run migrations first.");

  const norm = series.find((s) => !s.is_emergency) ?? series[0];
  const emer = series.find((s) => s.is_emergency) ?? series[0];

  const patients = [];
  let created = 0, tokens = 0;

  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    const iso = day.toISOString().slice(0, 10);
    const dow = day.getDay();

    // Sundays are quiet; weekdays busy. Gives the trend line a real shape.
    const base = dow === 0 ? 4 : dow === 6 ? 10 : 16;
    const count = Math.max(1, Math.round(base + (Math.random() - 0.5) * 8));

    /*
      Per-day counters, so numbering matches what the app would have produced.

      Seeded from what that day ALREADY holds rather than from zero. Running
      this twice — or running it on a database that has seen real tokens —
      otherwise regenerates numbers that exist, and unique_id rejects them.
    */
    const seqs = new Map();
    for (const row of await sql`
      select series_id, coalesce(max(seq), 0)::int as last
        from token where token_date = ${iso}
       group by series_id
    `) {
      seqs.set(Number(row.series_id), row.last);
    }

    for (let i = 0; i < count; i++) {
      const emergency = chance(0.15);
      const s = emergency ? emer : norm;
      const doctor = pick(doctors);
      const st = staff.length ? pick(staff) : { id: null };

      // ~55% returning once there is a pool to return to.
      let patient;
      if (patients.length > 8 && chance(0.55)) {
        patient = pick(patients);
      } else {
        const [{ next_mrn: mrn }] = await sql`select next_mrn()`;
        const name = `${pick(FIRST)} ${pick(LAST)}`;
        const [row] = await sql`
          insert into patient (mrn, name, phone, gender, age_years, created_at)
          values (${mrn}, ${name},
                  ${"03" + Math.floor(10000000 + Math.random() * 89999999)},
                  ${pick(["MALE", "FEMALE"])},
                  ${Math.floor(0 + Math.random() * 80)},
                  ${iso + " 09:00:00+05"})
          returning id
        `;
        patient = row;
        patients.push(row);
        created++;
      }

      const seq = (seqs.get(Number(s.id)) ?? 0) + 1;
      seqs.set(Number(s.id), seq);

      const hour = 9 + Math.floor(Math.random() * 11);
      const at = `${iso} ${String(hour).padStart(2, "0")}:${String(
        Math.floor(Math.random() * 60)).padStart(2, "0")}:00+05`;

      const [visit] = await sql`
        insert into visit (patient_id, series_id, visit_date, doctor_id, status,
                           opened_at, closed_at)
        values (${patient.id}, ${s.id}, ${iso}, ${doctor.id}, 'CLOSED',
                ${at}, ${at})
        returning id
      `;

      const disp = `${s.code}-${String(seq).padStart(5, "0")}`;
      const uid = `${s.code}-${iso.split("-").reverse().join("")}-${String(seq).padStart(5, "0")}`;
      await sql`
        insert into token (visit_id, series_id, token_date, seq, display_no,
                           unique_id, issued_at, issued_by, doctor_id)
        values (${visit.id}, ${s.id}, ${iso}, ${seq}, ${disp}, ${uid}, ${at},
                ${st.id}, ${doctor.id})
      `;
      await sql`
        insert into token_counter (counter_date, series_id, last_value)
        values (${iso}, ${s.id}, ${seq})
        on conflict (counter_date, series_id)
        do update set last_value = greatest(token_counter.last_value, ${seq})
      `;

      // consultation fee
      await sql`
        insert into visit_item (visit_id, service_id, name_snapshot,
                                unit_price_snapshot, qty, status, added_at, added_by)
        values (${visit.id}, null, ${(emergency ? "Emergency" : "Normal OPD") + " Fee"},
                ${s.base_fee}, 1, 'PAID', ${at}, ${st.id})
      `;

      // ~45% of visits add labs; emergencies more often
      const labCount = chance(emergency ? 0.6 : 0.42)
        ? 1 + Math.floor(Math.random() * 2) : 0;
      const used = new Set();
      for (let l = 0; l < labCount; l++) {
        const svc = pick(services.filter((x) => x.category !== "CONSULT"));
        if (!svc || used.has(svc.id)) continue;
        used.add(svc.id);
        await sql`
          insert into visit_item (visit_id, service_id, name_snapshot,
                                  unit_price_snapshot, qty, status, added_at, added_by)
          values (${visit.id}, ${svc.id}, ${svc.name}, ${svc.price}, 1,
                  ${chance(0.9) ? "PAID" : "PENDING"}, ${at}, ${st.id})
        `;
      }
      tokens++;
    }
  }

  console.log(`\nSeeded ${tokens} tokens and ${created} patients over ${DAYS} days.\n`);
} catch (err) {
  console.error("Seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
