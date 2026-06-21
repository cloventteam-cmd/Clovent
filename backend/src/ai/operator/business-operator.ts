import { queryMany, queryOne } from '../../db/client';
import { ai } from '../layer';
import type {
  UUID, DailyBriefing, BriefingAction, BriefingContact,
  BriefingDealRisk, RevenueForecast,
} from '../../shared/types';
import { PromptTemplates } from '../prompts/templates';
import { logger } from '../../shared/logger';

// ─── AI Business Operator ─────────────────────────────────────────────────────
// Derived entirely from internal data. No external signals.

export class BusinessOperator {
  private tenantId: UUID;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
  }

  async generateDailyBriefing(date: Date): Promise<Omit<DailyBriefing, 'id' | 'created_at'>> {
    logger.info({ tenant_id: this.tenantId }, 'Generating daily briefing');

    const [
      topActions,
      whoToContact,
      dealsAtRisk,
      revenueForecast,
    ] = await Promise.all([
      this.computeTopActions(),
      this.computeWhoToContact(),
      this.computeDealsAtRisk(),
      this.computeRevenueForecast(),
    ]);

    const summaryPrompt = PromptTemplates.dailyBriefing({
      hotLeads: whoToContact.slice(0, 3).map(c => `${c.contact_name} (${c.reason})`),
      dealsAtRisk: dealsAtRisk.slice(0, 3).map(d => d.deal_name),
      pipelineValue: revenueForecast.pipeline_value,
      tasksOverdue: topActions.filter(a => a.type === 'task_overdue').length,
    });

    const summary = await ai.complete(summaryPrompt, 300);

    return {
      tenant_id: this.tenantId,
      date,
      top_actions: topActions,
      who_to_contact: whoToContact,
      deals_at_risk: dealsAtRisk,
      revenue_forecast: revenueForecast,
      summary,
      generated_at: new Date(),
    };
  }

  private async computeTopActions(): Promise<BriefingAction[]> {
    const actions: BriefingAction[] = [];

    // Overdue tasks
    const overdueTasks = await queryMany<{ id: UUID; title: string; contact_id: UUID; due_at: Date }>(
      `SELECT id, title, contact_id, due_at FROM tasks
       WHERE tenant_id = $1 AND status = 'pending' AND due_at < NOW()
       ORDER BY due_at ASC LIMIT 5`,
      [this.tenantId],
    );

    for (const task of overdueTasks) {
      actions.push({
        priority: 1,
        type: 'task_overdue',
        title: `Overdue: ${task.title}`,
        description: `Task was due ${new Date(task.due_at).toLocaleDateString()}`,
        entity_type: 'task',
        entity_id: task.id,
      });
    }

    // High-probability opportunities
    const opportunities = await queryMany<{
      id: UUID; title: string; type: string; contact_id: UUID; score: number;
    }>(
      `SELECT id, title, type, contact_id, score FROM opportunities
       WHERE tenant_id = $1 AND status = 'open' AND priority IN ('high','critical')
       ORDER BY score DESC LIMIT 5`,
      [this.tenantId],
    );

    for (const opp of opportunities) {
      actions.push({
        priority: 2,
        type: `opportunity_${opp.type}`,
        title: opp.title,
        description: `Score: ${Math.round(opp.score * 100)}% — take action today`,
        entity_type: 'opportunity',
        entity_id: opp.id,
      });
    }

    // Deals moving slowly
    const stalledDeals = await queryMany<{ id: UUID; name: string; stage: string; updated_at: Date }>(
      `SELECT id, name, stage, updated_at FROM deals
       WHERE tenant_id = $1
         AND stage NOT IN ('closed_won','closed_lost','withdrawn')
         AND updated_at < NOW() - INTERVAL '7 days'
       ORDER BY updated_at ASC LIMIT 5`,
      [this.tenantId],
    );

    for (const deal of stalledDeals) {
      const daysStalled = Math.floor((Date.now() - new Date(deal.updated_at).getTime()) / 86400000);
      actions.push({
        priority: 3,
        type: 'deal_stalled',
        title: `Stalled deal: ${deal.name}`,
        description: `No activity for ${daysStalled} days in ${deal.stage} stage`,
        entity_type: 'deal',
        entity_id: deal.id,
      });
    }

    return actions.sort((a, b) => a.priority - b.priority).slice(0, 10);
  }

  private async computeWhoToContact(): Promise<BriefingContact[]> {
    // Top contacts by score who haven't been contacted recently
    const contacts = await queryMany<{
      id: UUID;
      first_name: string;
      last_name: string;
      buyer_probability: number;
      seller_probability: number;
      engagement_score: number;
      last_contacted_at: Date;
    }>(
      `SELECT id, first_name, last_name, buyer_probability, seller_probability,
              engagement_score, last_contacted_at
       FROM contacts
       WHERE tenant_id = $1
         AND status = 'active'
         AND (buyer_probability > 0.5 OR seller_probability > 0.5 OR engagement_score > 0.6)
       ORDER BY GREATEST(buyer_probability, seller_probability, engagement_score) DESC
       LIMIT 15`,
      [this.tenantId],
    );

    const result: BriefingContact[] = [];

    for (const c of contacts) {
      const daysSince = c.last_contacted_at
        ? Math.floor((Date.now() - new Date(c.last_contacted_at).getTime()) / 86400000)
        : null;

      // Skip if contacted recently (< 3 days)
      if (daysSince !== null && daysSince < 3) continue;

      const topScore = Math.max(c.buyer_probability, c.seller_probability, c.engagement_score);
      let reason = 'High engagement score';
      if (c.buyer_probability > 0.6) reason = 'High buyer probability';
      if (c.seller_probability > 0.6) reason = 'High seller probability';
      if (daysSince && daysSince > 30) reason += ` — ${daysSince} days since last contact`;

      result.push({
        contact_id: c.id,
        contact_name: `${c.first_name} ${c.last_name}`.trim(),
        reason,
        score: topScore,
        last_contact_days_ago: daysSince ?? undefined,
      });
    }

    return result.slice(0, 10);
  }

  private async computeDealsAtRisk(): Promise<BriefingDealRisk[]> {
    const riskyDeals = await queryMany<{
      id: UUID; name: string; risk_score: number;
      expected_close_date: Date; failure_probability: number;
    }>(
      `SELECT id, name, risk_score, expected_close_date, failure_probability
       FROM deals
       WHERE tenant_id = $1
         AND risk_score > 0.4
         AND stage NOT IN ('closed_won','closed_lost','withdrawn')
       ORDER BY risk_score DESC LIMIT 10`,
      [this.tenantId],
    );

    const result: BriefingDealRisk[] = [];

    for (const deal of riskyDeals) {
      // Get top risk category
      const topRisk = await queryOne<{ description: string }>(
        `SELECT description FROM deal_risks
         WHERE deal_id = $1 AND is_resolved = false
         ORDER BY risk_score DESC LIMIT 1`,
        [deal.id],
      );

      const daysToClose = deal.expected_close_date
        ? Math.floor((new Date(deal.expected_close_date).getTime() - Date.now()) / 86400000)
        : undefined;

      result.push({
        deal_id: deal.id,
        deal_name: deal.name,
        risk_score: deal.risk_score,
        top_risk: topRisk?.description ?? 'Multiple risk factors',
        days_to_close: daysToClose,
      });
    }

    return result;
  }

  private async computeRevenueForecast(): Promise<RevenueForecast> {
    const pipelineStats = await queryMany<{
      stage: string; total_value: string; weighted_value: string; count: string;
    }>(
      `SELECT stage,
              COALESCE(SUM(price), 0) AS total_value,
              COALESCE(SUM(price * probability / 100), 0) AS weighted_value,
              COUNT(*) AS count
       FROM deals
       WHERE tenant_id = $1 AND stage NOT IN ('closed_lost','withdrawn')
       GROUP BY stage`,
      [this.tenantId],
    );

    const closingStages = ['clear_to_close', 'financing', 'appraisal', 'inspection', 'under_contract'];
    const nextMonthStages = ['active', 'nurture'];

    let pipelineValue = 0;
    let weightedPipeline = 0;
    let thisMonthProjected = 0;
    let nextMonthProjected = 0;

    for (const row of pipelineStats) {
      const val = parseInt(row.total_value, 10);
      const weighted = parseInt(row.weighted_value, 10);
      pipelineValue += val;
      weightedPipeline += weighted;
      if (closingStages.includes(row.stage)) thisMonthProjected += weighted;
      if (nextMonthStages.includes(row.stage)) nextMonthProjected += weighted;
    }

    const riskStats = await queryOne<{ risk_value: string }>(
      `SELECT COALESCE(SUM(d.price), 0) AS risk_value
       FROM deals d
       WHERE d.tenant_id = $1 AND d.risk_score > 0.6
         AND d.stage NOT IN ('closed_won','closed_lost','withdrawn')`,
      [this.tenantId],
    );

    return {
      this_month_projected: thisMonthProjected,
      next_month_projected: nextMonthProjected,
      pipeline_value: pipelineValue,
      weighted_pipeline: weightedPipeline,
      deals_at_risk_value: parseInt(riskStats?.risk_value ?? '0', 10),
    };
  }
}
