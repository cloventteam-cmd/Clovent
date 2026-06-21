import { findDeals, findDealById, createDeal, updateDeal, getPipelineStats } from '../db/repositories/deals';
import { createActivity } from '../db/repositories/activities';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { RelationshipGraph } from '../modules/relationship-graph/graph';
import type { Deal, UUID, PaginatedResult } from '../shared/types';

export async function getDeals(
  tenantId: UUID,
  filter: Record<string, string> = {},
  page = 1,
  perPage = 25,
): Promise<PaginatedResult<Deal>> {
  return findDeals(tenantId, filter, page, perPage);
}

export async function getDeal(tenantId: UUID, id: UUID): Promise<Deal> {
  const deal = await findDealById(tenantId, id);
  if (!deal) throw new Error('Deal not found');
  return deal;
}

export async function addDeal(
  tenantId: UUID,
  userId: UUID,
  data: Partial<Deal>,
): Promise<Deal> {
  const deal = await createDeal(tenantId, { ...data, owner_id: userId });

  await createActivity(tenantId, {
    user_id: userId,
    contact_id: deal.contact_id,
    deal_id: deal.id,
    type: 'note',
    subject: 'Deal created',
    occurred_at: new Date(),
  });

  await eventBus.emit(EventNames.DEAL_CREATED, {
    tenant_id: tenantId,
    deal_id: deal.id,
    contact_id: deal.contact_id,
    stage: deal.stage,
  });

  return deal;
}

export async function moveDealStage(
  tenantId: UUID,
  userId: UUID,
  dealId: UUID,
  toStage: string,
): Promise<Deal> {
  const deal = await findDealById(tenantId, dealId);
  if (!deal) throw new Error('Deal not found');

  const updated = await updateDeal(tenantId, dealId, { stage: toStage as any });
  if (!updated) throw new Error('Update failed');

  await createActivity(tenantId, {
    user_id: userId,
    contact_id: deal.contact_id,
    deal_id: dealId,
    type: 'system',
    subject: `Stage changed: ${deal.stage} → ${toStage}`,
    metadata: { from_stage: deal.stage, to_stage: toStage },
    occurred_at: new Date(),
  });

  await eventBus.emit(EventNames.DEAL_STAGE_CHANGED, {
    tenant_id: tenantId,
    deal_id: dealId,
    contact_id: deal.contact_id,
    from_stage: deal.stage,
    to_stage: toStage,
    user_id: userId,
  });

  if (toStage === 'closed_won' || toStage === 'closed_lost') {
    await eventBus.emit(EventNames.DEAL_CLOSED, {
      tenant_id: tenantId,
      deal_id: dealId,
      outcome: toStage === 'closed_won' ? 'won' : 'lost',
    });

    if (toStage === 'closed_won' && deal.contact_id) {
      const graph = new RelationshipGraph(tenantId);
      await graph.updateEdgeFromDeal(dealId, deal.contact_id, deal.type);
    }
  }

  return updated;
}

export async function getPipeline(tenantId: UUID) {
  return getPipelineStats(tenantId);
}
