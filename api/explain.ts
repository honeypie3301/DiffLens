import { explainDiff, type ExplainPayload } from '../server/explainCore';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const payload = (await request.json()) as ExplainPayload;
    if (!payload || typeof payload.hunksPatch !== 'string') {
      return Response.json(
        { error: 'Invalid diff payload: hunksPatch string is required.' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const result = await explainDiff(payload);
    return Response.json(result, { status: 200, headers: CORS_HEADERS });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    const status = message.includes('MISSING_API_KEY')
      ? 503
      : message.includes('RESOURCE_EXHAUSTED') || message.includes('429')
      ? 429
      : 500;
    return Response.json({ error: message }, { status, headers: CORS_HEADERS });
  }
}
