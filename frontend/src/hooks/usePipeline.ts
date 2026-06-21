import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { streamClient } from '../lib/stream';
import type { PipelineStage, DealRisk, StreamEvent } from '../types';

export function usePipeline() {
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [risks,  setRisks]  = useState<DealRisk[]>([]);

  const loadPipeline = () => {
    api.pipeline().then(r => setStages(r.data ?? [])).catch(() => {});
    api.dealsAtRisk().then(r => setRisks(r.data ?? [])).catch(() => {});
  };

  useEffect(() => { loadPipeline(); }, []);

  useEffect(() => {
    return streamClient.on((e: StreamEvent) => {
      if (e.type === 'snapshot.pipeline') {
        setStages(e.payload as unknown as PipelineStage[]);
        return;
      }
      if (e.type === 'snapshot.risks') {
        setRisks(e.payload as unknown as DealRisk[]);
        return;
      }
      // Refresh on any deal change
      if (['deal.stage_changed', 'deal.risk_detected', 'deal.closed', 'deal.created'].includes(e.type)) {
        loadPipeline();
      }
    });
  }, []);

  return { stages, risks };
}
