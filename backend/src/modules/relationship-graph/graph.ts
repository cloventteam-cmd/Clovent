import { query, queryMany } from '../../db/client';
import type { UUID } from '../../shared/types';

interface GraphEdge {
  source_id: UUID;
  target_id: UUID;
  edge_type: string;
  strength: number;
}

interface GraphNode {
  contact_id: UUID;
  name: string;
  type: string;
  depth: number;
}

export class RelationshipGraph {
  private tenantId: UUID;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
  }

  async addEdge(
    sourceId: UUID,
    targetId: UUID,
    edgeType: string,
    strength = 0.5,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await query(
      `INSERT INTO relationship_edges (tenant_id, source_id, target_id, edge_type, strength, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, source_id, target_id, edge_type)
       DO UPDATE SET strength = GREATEST(relationship_edges.strength, EXCLUDED.strength), metadata = EXCLUDED.metadata`,
      [this.tenantId, sourceId, targetId, edgeType, strength, JSON.stringify(metadata)],
    );
  }

  async getNetwork(
    contactId: UUID,
    maxDepth = 2,
  ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    // BFS traversal using recursive CTE
    const result = await queryMany<{
      source_id: UUID;
      target_id: UUID;
      edge_type: string;
      strength: number;
      target_name: string;
      target_type: string;
      depth: number;
    }>(
      `WITH RECURSIVE network AS (
        SELECT re.source_id, re.target_id, re.edge_type, re.strength, 1 AS depth
        FROM relationship_edges re
        WHERE re.tenant_id = $1 AND re.source_id = $2
        UNION ALL
        SELECT re.source_id, re.target_id, re.edge_type, re.strength, n.depth + 1
        FROM relationship_edges re
        JOIN network n ON re.source_id = n.target_id
        WHERE re.tenant_id = $1 AND n.depth < $3
      )
      SELECT n.*, c.first_name || ' ' || c.last_name AS target_name, c.type AS target_type, n.depth
      FROM network n
      JOIN contacts c ON c.id = n.target_id AND c.tenant_id = $1`,
      [this.tenantId, contactId, maxDepth],
    );

    const edges: GraphEdge[] = result.map(r => ({
      source_id: r.source_id,
      target_id: r.target_id,
      edge_type: r.edge_type,
      strength: r.strength,
    }));

    const nodesMap = new Map<UUID, GraphNode>();
    for (const r of result) {
      if (!nodesMap.has(r.target_id)) {
        nodesMap.set(r.target_id, {
          contact_id: r.target_id,
          name: r.target_name,
          type: r.target_type,
          depth: r.depth,
        });
      }
    }

    return { nodes: Array.from(nodesMap.values()), edges };
  }

  async getReferralChain(
    contactId: UUID,
    maxDepth = 5,
  ): Promise<Array<{ contact_id: UUID; name: string; depth: number }>> {
    return queryMany(
      `WITH RECURSIVE chain AS (
        SELECT r.referred_id AS contact_id, 1 AS depth
        FROM referrals r
        WHERE r.tenant_id = $1 AND r.referrer_id = $2
        UNION ALL
        SELECT r.referred_id, c.depth + 1
        FROM referrals r
        JOIN chain c ON r.referrer_id = c.contact_id
        WHERE r.tenant_id = $1 AND c.depth < $3
      )
      SELECT ch.contact_id, co.first_name || ' ' || co.last_name AS name, ch.depth
      FROM chain ch
      JOIN contacts co ON co.id = ch.contact_id`,
      [this.tenantId, contactId, maxDepth],
    ) as any;
  }

  async updateEdgeFromDeal(dealId: UUID, contactId: UUID, dealType: string): Promise<void> {
    // When a deal closes, strengthen relationship edges
    await this.addEdge(contactId, contactId, 'agent_client', 0.9, { deal_id: dealId, deal_type: dealType });
  }
}
