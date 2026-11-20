// Reseed Postgres to the demo state: SOP-EQ-014 v1 + ~40 past findings (repeat-deviation memory for pgvector).
// Runs on an app node (the DB is VPC-only):  sudo -u labstrata bash -c 'set -a; . /etc/labstrata/env; node infra/seed.js'
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const db = require('../lib/db');
const { embed, akamaiReady } = require('../lib/akamai');
const { start, ensureSeed } = require('../server');

const SOP_LINES = {
  5: 'Step 2. Inspect the rotor and rotor lid for cracks or corrosion; record the rotor serial number.',
  6: 'Step 3. Pre-cool the chamber to 4 °C and record the displayed temperature before loading.',
  7: 'Step 4. Balance the rotor: load tubes in opposite positions with equal mass (within 0.1 g) and record each tube mass.',
  9: 'Step 6. Set the run to 12,000 x g for 10 min at 4 °C and start the run.',
  12: 'Step 9. Wipe the chamber with 70% ethanol and record the run end time.',
};
// Step 4 "missed" 3x this month by 2 operators is the hero line; the rest is background noise.
const PLAN = [
  [7, 'missed', 'M. Chen', 3], [7, 'missed', 'T. Nguyen', 9], [7, 'missed', 'M. Chen', 17],
  [7, 'unverifiable', 'S. Park', 40], [6, 'unverifiable', 'M. Chen', 3], [6, 'unverifiable', 'R. Patel', 6],
  [6, 'unverifiable', 'S. Park', 12], [6, 'unverifiable', 'M. Chen', 21], [6, 'unverifiable', 'T. Nguyen', 26],
  [5, 'unverifiable', 'M. Chen', 3], [5, 'unverifiable', 'K. Osei', 8], [5, 'unverifiable', 'R. Patel', 15],
  [5, 'unverifiable', 'J. Rivera', 33], [9, 'deviation', 'R. Patel', 5], [9, 'deviation', 'R. Patel', 19],
  [9, 'deviation', 'S. Park', 45], [12, 'missed', 'T. Nguyen', 9], [12, 'missed', 'K. Osei', 11],
  [12, 'unverifiable', 'J. Rivera', 14], [12, 'missed', 'S. Park', 22],
];
// pad to ~40 with verified history so counts look like a real lab
const OPS = ['M. Chen', 'J. Rivera', 'K. Osei', 'T. Nguyen', 'R. Patel', 'S. Park'];
for (let i = 0; PLAN.length < 40; i++) PLAN.push([[5, 6, 7, 9, 12][i % 5], 'verified', OPS[i % 6], 1 + ((i * 7) % 28)]);

(async () => {
  await db.init();
  await db.resetDemo();
  if (db.mode().mode === 'postgres') await db.query('DELETE FROM findings WHERE seeded = true');
  await ensureSeed();
  const flagged = PLAN.filter(p => p[1] !== 'verified');
  let vecs = [];
  if (akamaiReady()) {
    try { vecs = await embed(flagged.map(([line, status]) => `${SOP_LINES[line]} | ${status}`)); }
    catch (e) { console.warn('embeddings skipped:', e.message); }
  }
  let k = 0;
  for (const [line, status, op, daysAgo] of PLAN) {
    const isFlag = status !== 'verified';
    const at = new Date(Date.now() - daysAgo * 864e5).toISOString();
    await db.addFindings(`seed_${String(k).padStart(2, '0')}`, op, [{ sop_line: line, sop_text: SOP_LINES[line], status, reason: 'seeded history' }],
      isFlag ? [vecs[flagged.indexOf(PLAN[k])]] : [], { seeded: true, createdAt: at });
    k++;
  }
  console.log(`seeded ${PLAN.length} past findings (${vecs.length ? 'with' : 'without'} embeddings) into ${db.mode().mode}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
void start;
