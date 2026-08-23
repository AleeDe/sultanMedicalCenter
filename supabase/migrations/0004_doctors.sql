-- Doctors.
--
-- The token now records WHO the patient is going to see. Fees stay driven by
-- the visit type (Normal / Emergency), so a doctor carries no price of its
-- own — a deliberate choice, so that changing a doctor never silently changes
-- what the patient is charged.

create table doctor (
  id         bigint generated always as identity primary key,
  name       text    not null,
  speciality text    not null default '',
  room       text    not null default '',
  active     boolean not null default true,
  sort_order smallint not null default 0
);

create index doctor_active_idx on doctor (sort_order, name) where active;

insert into doctor (name, speciality, room, sort_order) values
  ('Dr. Ahmed Raza',  'General Physician', 'Room 1', 1),
  ('Dr. Sara Iqbal',  'Gynaecology',       'Room 2', 2),
  ('Dr. Bilal Hasan', 'Orthopaedics',      'Room 3', 3),
  ('Dr. Nadia Khan',  'Paediatrics',       'Room 4', 4);

-- Nullable: emergency arrivals are sometimes seen by whoever is free, and
-- historic visits pre-date this column.
alter table visit  add column doctor_id bigint references doctor(id);
alter table token  add column doctor_id bigint references doctor(id);

create index visit_doctor_idx on visit (doctor_id, visit_date);
