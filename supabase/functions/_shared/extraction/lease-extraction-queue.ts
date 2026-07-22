// @ts-nocheck

export function normalizeLeaseExtractionGenerationResult(generationResult: any, generationError?: any) {
  if (generationError) {
    return {
      job: null,
      error: generationError?.message || String(generationError),
    };
  }

  if (!generationResult?.job_id) {
    return { job: null, error: "missing job id" };
  }

  if (!generationResult?.generation_id) {
    return { job: null, error: "missing generation id" };
  }

  return {
    job: {
      id: generationResult.job_id,
      generationId: generationResult.generation_id,
    },
    error: null,
  };
}