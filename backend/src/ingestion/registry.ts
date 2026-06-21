/**
 * Connector Registry
 * Maps CRM types to connector instances (singletons — connectors are stateless).
 */
import type { ICrmConnector, CrmType } from './types';
import { HubSpotConnector } from './connectors/hubspot.connector';
import { SalesforceConnector } from './connectors/salesforce.connector';
import { FollowUpBossConnector } from './connectors/followupboss.connector';
import { GenericRestConnector } from './connectors/generic-rest.connector';

const registry = new Map<CrmType, ICrmConnector>([
  ['hubspot',      new HubSpotConnector()],
  ['salesforce',   new SalesforceConnector()],
  ['followupboss', new FollowUpBossConnector()],
  ['generic_rest', new GenericRestConnector()],
  // kvcore reuses generic_rest connector with specific settings
  ['kvcore',       new GenericRestConnector()],
]);

export function getConnector(crmType: CrmType): ICrmConnector {
  const connector = registry.get(crmType);
  if (!connector) throw new Error(`No connector registered for CRM type: ${crmType}`);
  return connector;
}

export function listSupportedCrms(): CrmType[] {
  return Array.from(registry.keys());
}
