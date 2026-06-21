/**
 * CLOVENT Pipeline Integration Runner
 *
 * End-to-end integration test using real DB, real workers, real events.
 * Run: npx tsx src/pipeline/run.ts
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';

// ── Isolate queues so the dev server doesn't compete for our test jobs ─────────
// Must happen before any import that reads config.queues.
const RUN_PREFIX = `test-${randomUUID().slice(0, 8)}`;
process.env.QUEUE_PREFIX = RUN_PREFIX;

import { pool, query, queryOne, queryMany } from '../db/client';
import { redisConnection } from '../workers/queue';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { startAllWorkers } from '../workers/index';
import '../events/pipeline';

const RUN_ID = RUN_PREFIX.slice(5); // strip "test-"
const t0 = Date.now();
function ms() { return `+${String(Date.now() - t0).padStart(5)}ms`; }

// ── Seeded IDs ────────────────────────────────────────────────────────────────
const IDS = {
  org:     randomUUID(),
  user:    randomUUID(),
  contact: randomUUID(),
  deal:    randomUUID(),
};

// ── Event audit tap ───────────────────────────────────────────────────────────
const fired: Record<string, number> = {};
const TRACKED = [
  EventNames.CONTACT_CREATED,
  EventNames.CONTACT_SCORED,
  EventNames.OPPORTUNITY_DETECTED,
  EventNames.IMPORT_COMPLETED,
  EventNames.SCORING_BATCH_REQUESTED,
  EventNames.DEAL_STAGE_CHANGED,
  EventNames.DEAL_RISK_DETECTED,
  EventNames.NOTIFICATION_SEND,
  EventNames.ACTIVITY_CREATED,
  EventNames.SCORING_REQUESTED,
];

for (const name of TRACKED) {
  eventBus.on(name as any, async () => {
    fired[name] = (fired[name] ?? 0) + 1;
    console.log(`  ✓ [${ms()}] ${name}`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await wait(intervalMs);
  }
  console.log(`  ⏱  TIMEOUT: ${label}`);
  return false;
}

// ── Seed / teardown ───────────────────────────────────────────────────────────
async function seed() {
  await query(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)`,
    [IDS.org, `Test Org ${RUN_ID}`, `test-${RUN_ID}`]);
  await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, role)
     VALUES ($1,$2,$3,'$2b$12$xxx','Test','Runner','owner')`,
    [IDS.user, IDS.org, `runner-${RUN_ID}@test.local`]);
  await query(
    `INSERT INTO contacts (id, tenant_id, owner_id, first_name, last_name, email, type)
     VALUES ($1,$2,$3,'Pipeline','Test','pipeline@test.local','lead')`,
    [IDS.contact, IDS.org, IDS.user]);
  await query(
    `INSERT INTO deals (id, tenant_id, owner_id, contact_id, name, type, stage, pipeline)
     VALUES ($1,$2,$3,$4,'Test Deal','buyer','active','residential')`,
    [IDS.deal, IDS.org, IDS.user, IDS.contact]);
}

async function teardown() {
  await query('DELETE FROM organizations WHERE id = $1', [IDS.org]).catch(() => {});
}

// ── Assertions ────────────────────────────────────────────────────────────────
type Assert = { label: string; pass: boolean; detail?: string };

async function check(label: string, fn: () => Promise<{ pass: boolean; detail?: string }>): Promise<Assert> {
  try { return { label, ...(await fn()) }; }
  catch (e: any) { return { label, pass: false, detail: e.message }; }
}

// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n🚀 CLOVENT Pipeline Integration Test  [run:${RUN_ID}]\n`);

  startAllWorkers();
  await wait(500);
  await seed();
  console.log(`  Seeded: org=${IDS.org.slice(0,8)} contact=${IDS.contact.slice(0,8)} deal=${IDS.deal.slice(0,8)}\n`);

  // ─── Pipeline 1: CONTACT_CREATED → score → opportunity → notification ──────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PIPELINE 1  CONTACT_CREATED → Score → Opportunity → Notification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Pre-load the contact with a showing + meeting so scores are high enough
  // for the opportunity threshold (buyer_probability ≥ 0.45).
  const act1 = randomUUID(), act2 = randomUUID(), act3 = randomUUID();
  await query(
    `INSERT INTO activities (id,tenant_id,user_id,contact_id,type,subject,occurred_at)
     VALUES ($1,$2,$3,$4,'showing','Brickell tour',NOW()-INTERVAL'2 days'),
            ($5,$2,$3,$4,'meeting','Buyer consultation',NOW()-INTERVAL'1 day'),
            ($6,$2,$3,$4,'call','Follow-up call',NOW())`,
    [act1, IDS.org, IDS.user, IDS.contact, act2, act3],
  );

  console.log('[→] Emit CONTACT_CREATED');
  await eventBus.emit(EventNames.CONTACT_CREATED, {
    tenant_id: IDS.org,
    contact_id: IDS.contact,
    source: 'csv',
  });

  console.log('[⌛] Waiting for scoring worker to update DB...');
  await waitFor('contact buyer_probability > 0', async () => {
    const r = await queryOne<{ buyer_probability: string }>(
      'SELECT buyer_probability FROM contacts WHERE id = $1', [IDS.contact]);
    return parseFloat(r?.buyer_probability ?? '0') > 0;
  });

  // Wait for the OPPORTUNITY_DETECTED event itself — not just the DB row,
  // because the DB row is inserted slightly before eventBus.emit is called.
  console.log('[⌛] Waiting for opportunity.detected event...');
  await waitFor('opportunity.detected event fired', async () =>
    (fired[EventNames.OPPORTUNITY_DETECTED] ?? 0) > 0
  );

  // ─── Pipeline 2: ACTIVITY_CREATED → scoring re-trigger ────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PIPELINE 2  ACTIVITY_CREATED → SCORING_REQUESTED → re-score');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const showingId = randomUUID();
  await query(
    `INSERT INTO activities (id,tenant_id,user_id,contact_id,type,subject,body,occurred_at)
     VALUES ($1,$2,$3,$4,'showing','New showing','Strong interest.',NOW())`,
    [showingId, IDS.org, IDS.user, IDS.contact],
  );

  console.log('[→] Emit ACTIVITY_CREATED (showing)');
  await eventBus.emit(EventNames.ACTIVITY_CREATED, {
    tenant_id: IDS.org,
    activity_id: showingId,
    contact_id: IDS.contact,
    deal_id: IDS.deal,
    activity_type: 'showing',
  });

  // Wait for scoring to run again (contact_scores gets a 2nd row)
  await waitFor('contact_scores has ≥ 2 rows', async () => {
    const rows = await queryMany('SELECT id FROM contact_scores WHERE contact_id = $1', [IDS.contact]);
    return rows.length >= 2;
  }, 8000);

  // ─── Pipeline 3: DEAL_STAGE_CHANGED → probability + risk + notification ────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PIPELINE 3  DEAL_STAGE_CHANGED → Probability → Risk → Notification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Update the stage in DB first so the risk worker reads the correct stage
  await query('UPDATE deals SET stage = $1 WHERE id = $2', ['inspection', IDS.deal]);

  console.log('[→] Emit DEAL_STAGE_CHANGED (active → inspection)');
  await eventBus.emit(EventNames.DEAL_STAGE_CHANGED, {
    tenant_id: IDS.org,
    deal_id: IDS.deal,
    contact_id: IDS.contact,
    from_stage: 'active',
    to_stage: 'inspection',
    user_id: IDS.user,
  });

  console.log('[⌛] Waiting for probability worker...');
  await waitFor('deal probability = 70', async () => {
    const r = await queryOne<{ probability: number }>(
      'SELECT probability FROM deals WHERE id = $1', [IDS.deal]);
    return r?.probability === 70;
  });

  // Same pattern — wait for DEAL_RISK_DETECTED event, not just the DB row
  console.log('[⌛] Waiting for deal.risk_detected event...');
  await waitFor('deal.risk_detected event fired', async () =>
    (fired[EventNames.DEAL_RISK_DETECTED] ?? 0) > 0
  );

  // ─── Pipeline 4: IMPORT_COMPLETED → SCORING_BATCH_REQUESTED ───────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PIPELINE 4  IMPORT_COMPLETED → SCORING_BATCH_REQUESTED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const importId = randomUUID();
  await query(
    `INSERT INTO imports (id, tenant_id, user_id, name, source_type)
     VALUES ($1,$2,$3,'Integration Test Import','csv')`,
    [importId, IDS.org, IDS.user],
  );
  await query('UPDATE contacts SET import_id = $1 WHERE id = $2', [importId, IDS.contact]);

  console.log('[→] Emit IMPORT_COMPLETED');
  await eventBus.emit(EventNames.IMPORT_COMPLETED, {
    tenant_id: IDS.org,
    import_id: importId,
    stats: { total: 1, created: 1, updated: 0, skipped: 0, errors: 0 },
  });

  // Wait for SCORING_BATCH_REQUESTED to be handled → scoring job queued
  await waitFor('imports.status = completed', async () => {
    const r = await queryOne<{ status: string }>(
      'SELECT status FROM imports WHERE id = $1', [importId]);
    return r?.status === 'completed';
  });

  await wait(1000); // allow batch scoring to queue

  // ─── Assertions ───────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('ASSERTIONS — DB state');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const assertions = await Promise.all([
    check('Contact scores written to contacts table', async () => {
      const r = await queryOne<{ buyer_probability: string; engagement_score: string }>(
        'SELECT buyer_probability, engagement_score FROM contacts WHERE id = $1', [IDS.contact]);
      const pass = parseFloat(r?.buyer_probability ?? '0') > 0;
      return { pass, detail: `buyer=${r?.buyer_probability} engagement=${r?.engagement_score}` };
    }),

    check('contact_scores history has ≥ 2 rows (scored twice)', async () => {
      const rows = await queryMany('SELECT id FROM contact_scores WHERE contact_id = $1', [IDS.contact]);
      return { pass: rows.length >= 2, detail: `rows=${rows.length}` };
    }),

    check('Opportunity detected and stored in DB', async () => {
      const r = await queryOne<{ type: string; score: string; priority: string }>(
        'SELECT type, score, priority FROM opportunities WHERE contact_id = $1 ORDER BY created_at LIMIT 1',
        [IDS.contact]);
      return {
        pass: !!r,
        detail: r ? `type=${r.type} score=${parseFloat(r.score).toFixed(3)} priority=${r.priority}` : 'not found',
      };
    }),

    check('Deal probability updated to 70% (inspection)', async () => {
      const r = await queryOne<{ probability: number }>('SELECT probability FROM deals WHERE id = $1', [IDS.deal]);
      return { pass: r?.probability === 70, detail: `probability=${r?.probability}` };
    }),

    check('Deal risk row written by risk worker', async () => {
      const r = await queryOne<{ category: string; risk_score: string }>(
        'SELECT category, risk_score FROM deal_risks WHERE deal_id = $1', [IDS.deal]);
      return {
        pass: !!r,
        detail: r ? `category=${r.category} score=${parseFloat(r.risk_score).toFixed(3)}` : 'not found',
      };
    }),

    check('In-app notification created for deal risk or hot lead', async () => {
      const r = await queryOne(
        `SELECT type FROM notifications WHERE user_id = $1 ORDER BY created_at LIMIT 1`, [IDS.user]);
      return { pass: !!r, detail: r ? `type=${(r as any).type}` : 'not found' };
    }),

    check('Import status set to completed', async () => {
      const r = await queryOne<{ status: string }>('SELECT status FROM imports WHERE id = $1', [importId]);
      return { pass: r?.status === 'completed', detail: `status=${r?.status}` };
    }),

    check('Showing activity in activities table', async () => {
      const rows = await queryMany(
        `SELECT id FROM activities WHERE contact_id = $1 AND type = 'showing'`, [IDS.contact]);
      return { pass: rows.length >= 1, detail: `showing rows=${rows.length}` };
    }),
  ]);

  for (const a of assertions) {
    const icon = a.pass ? '✅' : '❌';
    const detail = a.detail ? `  (${a.detail})` : '';
    console.log(`  ${icon} ${a.label}${detail}`);
  }

  // ─── Event summary ─────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('EVENTS FIRED');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let allEventsOk = true;
  for (const name of TRACKED) {
    const count = fired[name] ?? 0;
    if (!count) allEventsOk = false;
    console.log(`  ${count > 0 ? '✅' : '❌'} ${name.padEnd(40)} × ${count}`);
  }

  const assertOk = assertions.every(a => a.pass);
  const allOk = allEventsOk && assertOk;
  const totalFired = Object.values(fired).reduce((s, n) => s + n, 0);

  console.log(`\n  Events total:  ${totalFired}`);
  console.log(`  Elapsed:       ${Date.now() - t0}ms`);
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  ${allOk ? '✅ ALL PIPELINES PASS' : '❌ SOME CHECKS FAILED'}                  │`);
  console.log(`  └─────────────────────────────────────────┘\n`);

  await teardown();
  console.log('  Seed data cleaned up.\n');

  await pool.end();
  redisConnection.disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch(async err => {
  console.error('\n❌ Runner crashed:', err.message);
  await teardown().catch(() => {});
  process.exit(1);
});
