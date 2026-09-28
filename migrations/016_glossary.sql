-- ═══════════════════════════════════════════════════════════════════════════
--  UCDFS: the glossary, as rows
--
--  /glossary shipped as a list written into the page, so changing a definition
--  was a pull request. It is content the team's leads own and want to fix the
--  day they notice a gap, so it is data now, edited on the page itself by
--  admins, committee and captains (_may_edit_glossary in main.py).
--
--  Categories stay in code (GLOSSARY_GROUPS in main.py). They change about
--  never, and a row naming one that does not exist is drawn under the first
--  rather than vanishing, the same fallback dashboard blocks use.
--
--  Seeded with the terms the page shipped with, so nothing disappears on the
--  day this lands. Two were corrected on the way: "Purchase request" claimed
--  nothing is reimbursed without one, which is not the rule, and "LV" said the
--  low-voltage side always has its own battery.
--
--  Additive and re-runnable: the inserts skip anything already there, by id or
--  by name.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.glossary_terms (
  -- Minted server-side (term_…), like link_… and chart_…. The seed uses
  -- readable slugs; nothing reads meaning into either.
  id          text        primary key,
  term        text        not null,
  -- What an abbreviation stands for, or another name for the same thing.
  expansion   text        not null default '',
  definition  text        not null,
  -- One of the GLOSSARY_GROUPS ids in main.py. Text, not a foreign key,
  -- because the categories are code, not rows.
  category    text        not null default 'comp',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Who last changed it: the name at write time, like links.created_by.
  -- There is no undo, so "who wrote this" has to be answerable. Stripped by
  -- seed-nonprod.sh, because it is about a person.
  updated_by  text        not null default ''
);

comment on table public.glossary_terms is
  'The /glossary page: one row per term, edited on the page by admins, committee and captains.';

-- One entry per term, whatever the capitalisation: two "TSAL"s would each be
-- half right. The API checks first and says so; this is the backstop.
create unique index if not exists glossary_terms_term_key
  on public.glossary_terms (lower(term));

drop trigger if exists glossary_terms_updated_at on public.glossary_terms;
create trigger glossary_terms_updated_at
  before update on public.glossary_terms
  for each row execute function public.update_updated_at();

-- Same posture as every other table: RLS on, zero policies. All access is
-- through FastAPI with the service key; see 001.
alter table public.glossary_terms enable row level security;

insert into public.glossary_terms (id, term, expansion, definition, category) values
  ('term_formula-student', 'Formula Student', 'FS', 'A student engineering competition: design, build and race a single-seat car. Points come from the engineering and the business case as well as the driving, so a fast car with no answers can lose to a slower one that has them.', 'comp'),
  ('term_fsuk', 'FSUK', 'Formula Student UK', 'Our main competition, held at Silverstone each summer and run by the IMechE.', 'comp'),
  ('term_imeche', 'IMechE', 'Institution of Mechanical Engineers', 'The body that runs FSUK and sets its dates and entry process.', 'comp'),
  ('term_fsae', 'FSAE', '', 'The original US competition. People also use it loosely for the whole family of Formula Student events, which is why the subreddit is r/FSAE.', 'comp'),
  ('term_the-rules', 'The rules', '', 'The rulebook every car is built and inspected against, plus FSUK’s own event handbook. It changes every year, so always check the current edition before designing to a number you remember.', 'comp'),
  ('term_static-events', 'Static events', '', 'The events judged off the track: Design, Cost and Manufacturing, and the Business Plan Presentation.', 'comp'),
  ('term_design-event', 'Design Event', '', 'Judges question the team on engineering decisions. “Why did you choose this?” matters as much as what you chose, which is why writing decisions down as you go pays off.', 'comp'),
  ('term_cost-event', 'Cost Event', 'Cost and Manufacturing', 'A costed breakdown of the whole car and how it is made, then questions on it. Every receipt and part number we keep during the year feeds this.', 'comp'),
  ('term_bpp', 'BPP', 'Business Plan Presentation', 'A pitch to judges playing investors, built around the car as a product.', 'comp'),
  ('term_dynamic-events', 'Dynamic events', '', 'The events on track: Acceleration, Skidpad, Autocross, Endurance and Efficiency.', 'comp'),
  ('term_acceleration', 'Acceleration', '', 'A straight-line sprint from a standing start.', 'comp'),
  ('term_skidpad', 'Skidpad', '', 'A figure of eight around two circles, measuring how much grip the car holds in steady cornering.', 'comp'),
  ('term_autocross', 'Autocross', 'sometimes Sprint', 'A single fast lap of a tight cone course. It usually sets the running order for Endurance.', 'comp'),
  ('term_endurance', 'Endurance', '', 'The long one, with a driver change halfway. Worth the most points, and where most cars stop, so reliability beats peak performance.', 'comp'),
  ('term_efficiency', 'Efficiency', '', 'Scored from the energy the car uses during Endurance, weighed against its lap times.', 'comp'),
  ('term_scrutineering', 'Scrutineering', 'technical inspection', 'The checks a car must pass before it is allowed on track: mechanical and electrical inspection, then the tilt, rain and brake tests. No sticker, no driving.', 'comp'),
  ('term_tilt-test', 'Tilt test', '', 'The car is tipped sideways on a table, with a driver in it, to check nothing leaks and it does not roll over.', 'comp'),
  ('term_rain-test', 'Rain test', '', 'The electric car is sprayed with water while live, to show the insulation holds.', 'comp'),
  ('term_brake-test', 'Brake test', '', 'Get up to speed, then stop with all four wheels locked in a straight line.', 'comp'),
  ('term_ts', 'TS', 'Tractive System', 'Everything carrying the high-voltage power that drives the car: accumulator, inverter, motor and the wiring between them.', 'elec'),
  ('term_hv', 'HV', 'high voltage', 'Team shorthand for anything on the tractive system. Treat it as live until someone qualified has shown you it is not.', 'elec'),
  ('term_lv', 'LV', 'low voltage', 'The rest of the car’s electrics: sensors, controllers, dash and the shutdown circuit, usually running from a small separate battery.', 'elec'),
  ('term_accumulator', 'Accumulator', '', 'The traction battery pack, split into segments inside a protective container.', 'elec'),
  ('term_ams-bms', 'AMS / BMS', 'Accumulator / Battery Management System', 'Watches every cell’s voltage and temperature, and opens the shutdown circuit if any go out of range.', 'elec'),
  ('term_imd', 'IMD', 'Insulation Monitoring Device', 'Checks the tractive system stays isolated from the chassis, and trips the shutdown circuit if it is not.', 'elec'),
  ('term_sdc', 'SDC', 'Shutdown Circuit', 'A chain of switches and safety devices in series. Break it anywhere and the tractive system turns off.', 'elec'),
  ('term_airs', 'AIRs', 'Accumulator Isolation Relays', 'The contactors at the accumulator that connect and disconnect the tractive system.', 'elec'),
  ('term_precharge', 'Precharge', '', 'Charging the inverter’s capacitors slowly through a resistor before connecting fully, so switching on does not weld the relays with a current spike.', 'elec'),
  ('term_discharge', 'Discharge', '', 'Draining those capacitors when the tractive system turns off, so the car is safe to touch soon after.', 'elec'),
  ('term_tsal', 'TSAL', 'Tractive System Active Light', 'The light on the roll hoop that shows whether the tractive system is live. Check it before touching the car.', 'elec'),
  ('term_tsms', 'TSMS', 'Tractive System Master Switch', 'The switch that has to be on before the tractive system can be energised.', 'elec'),
  ('term_bspd', 'BSPD', 'Brake System Plausibility Device', 'A standalone circuit that cuts power if the driver is braking hard while the motor is still delivering high power.', 'elec'),
  ('term_apps', 'APPS', 'Accelerator Pedal Position Sensor', 'Two redundant sensors on the throttle pedal. If they disagree, power is cut.', 'elec'),
  ('term_inverter', 'Inverter', 'motor controller', 'Turns the accumulator’s DC into the AC that drives the motor.', 'elec'),
  ('term_vcu', 'VCU', 'Vehicle Control Unit', 'The car’s main controller: reads the pedals and sensors, decides how much torque to ask for. Our code for it is linked from the dashboard.', 'elec'),
  ('term_can-bus', 'CAN bus', '', 'The two-wire network the car’s controllers use to talk to each other.', 'elec'),
  ('term_esf', 'ESF', 'Electrical System Form', 'The document describing the car’s electrical design, submitted to the competition ahead of the event.', 'elec'),
  ('term_harness', 'Harness', 'or loom', 'The car’s wiring, built as bundles with connectors on the ends. We design ours in HarnessHive.', 'elec'),
  ('term_dt-dtm', 'DT / DTM', 'Deutsch connectors', 'Two common connector series. They look alike and are not interchangeable: different housings and different contact sizes. Order the right one.', 'elec'),
  ('term_crimp', 'Crimp', '', 'Joining a wire to a contact by squeezing it with the right tool. Wrong tool or wrong wire gauge is a common cause of intermittent faults.', 'elec'),
  ('term_chassis', 'Chassis', 'spaceframe or monocoque', 'The car’s main structure: a spaceframe is welded tubes, a monocoque is a single composite tub.', 'mech'),
  ('term_main-hoop-front-hoop', 'Main hoop / front hoop', '', 'The two roll hoops that protect the driver if the car goes over.', 'mech'),
  ('term_impact-attenuator', 'Impact attenuator', 'IA', 'The crushable structure on the nose that absorbs a frontal crash.', 'mech'),
  ('term_upright', 'Upright', '', 'The part at each corner holding the wheel bearing and brake caliper, connecting the wheel to the suspension.', 'mech'),
  ('term_wishbone', 'Wishbone', 'A-arm', 'The triangular links connecting each upright to the chassis.', 'mech'),
  ('term_pushrod-pullrod', 'Pushrod / pullrod', '', 'The rod that carries suspension movement from the wheel to the rocker and damper.', 'mech'),
  ('term_damper', 'Damper', 'shock', 'Controls how fast the suspension moves. The spring holds the car up; the damper stops it bouncing.', 'mech'),
  ('term_anti-roll-bar', 'Anti-roll bar', 'ARB', 'Links left and right suspension to limit body roll in corners.', 'mech'),
  ('term_camber-toe', 'Camber / toe', '', 'Wheel angles: camber is the tilt seen from the front, toe is whether the wheels point in or out seen from above. Small changes, big effect on grip.', 'mech'),
  ('term_aero', 'Aero', '', 'The wings and undertray that push the car into the ground for more grip, at the cost of drag.', 'mech'),
  ('term_diff', 'Diff', 'differential', 'Lets the rear wheels turn at different speeds through a corner.', 'mech'),
  ('term_ergonomics', 'Ergonomics', '', 'Fitting drivers of every size into the car safely: seat, pedals, steering wheel, and getting out fast.', 'mech'),
  ('term_divisions', 'Divisions', '', 'Electrical, Mechanical and Operations. Electrical is called “pt” (powertrain) in some older places on this site.', 'team'),
  ('term_team-principal', 'Team Principal', 'TP', 'Leads the whole team.', 'team'),
  ('term_technical-director', 'Technical Director', 'TD', 'Leads the engineering side, across Electrical and Mechanical.', 'team'),
  ('term_captain', 'Captain', '', 'Leads a division. Your captain is who to ask first, and who approves your division’s purchase requests.', 'team'),
  ('term_onshape', 'Onshape', '', 'The browser-based CAD tool the car is designed in. Linked from the dashboard.', 'team'),
  ('term_harnesshive', 'HarnessHive', '', 'Where the wiring harness is designed. Linked from the dashboard.', 'team'),
  ('term_build-plan', 'Build plan', 'flowchart', 'Each division’s chart of tasks and what depends on what, under Flowcharts. Tick things off as you finish them.', 'team'),
  ('term_purchase-request', 'Purchase request', '', 'How you ask for the team to buy something. Your captain approves it, and bigger spends need the Operations captain as well. Raise one before you buy, not after.', 'team'),
  ('term_shop-run', 'Shop run', '', 'At competition, one person goes shopping for everyone. The Competition Hub tracks who asked for what and who owes whom.', 'team')
on conflict do nothing;
