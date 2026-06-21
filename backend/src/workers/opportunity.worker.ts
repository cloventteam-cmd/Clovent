import type { Job } from 'bullmq';
import { createWorker, type OpportunityJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { OpportunityEngine } from '../modules/opportunity/engine';

async function processOpportunityJob(job: Job<OpportunityJobData>): Promise<void> {
  const { tenant_id, contact_id } = job.data;

  const engine = new OpportunityEngine(tenant_id);

  if (contact_id) {
    logger.debug({ contact_id }, 'Opportunity worker: scanning single contact');
    await engine.scanContact(contact_id);
  } else {
    logger.info({ tenant_id }, 'Opportunity worker: full tenant scan');
    await engine.scanAll();
  }
}

export function startOpportunityWorker(): void {
  createWorker<OpportunityJobData>(config.queues.opportunity, processOpportunityJob, 5);
  logger.info({ queue: config.queues.opportunity, concurrency: 5 }, 'Opportunity worker started');
}
