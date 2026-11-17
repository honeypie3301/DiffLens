import { explainDiff, type ExplainPayload } from '../server/explainCore';

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = (await request.json()) as ExplainPayload;
    if (!payload || typeof payload.hunksPatch !== 'string') {
      return Response.json(
        { error: 'Invalid diff payload: hunksPatch string is required.' },
        { status: 400 }
      );
    }

    const result = await explainDiff(payload);
    return Response.json(result, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    const status = message.includes('MISSING_API_KEY')
      ? 503
      : message.includes('RESOURCE_EXHAUSTED') || message.includes('429')
      ? 429
      : 500;
    return Response.json({ error: message }, { status });
  }
}
