import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

/** Vercel AI Gateway: same Jev model, billed through the gateway key. */
export const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';
export const GATEWAY_DEFAULT_MODEL = 'typesafe-ai/jev';
export type JevProvider = 'typesafe' | 'gateway';

/** Maps a TypeSafe model name onto the gateway's `provider/model` id. */
export function gatewayModelId(model: string | undefined): string {
  if (!model || model === DEFAULT_MODEL) return GATEWAY_DEFAULT_MODEL;
  return model.includes('/') ? model : `typesafe-ai/${model}`;
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    /** `typesafe` (default) hits System One directly; `gateway` goes through Vercel AI Gateway. */
    provider?: JevProvider;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  if (params.provider === 'gateway') {
    // The gateway speaks the AI SDK evaluation protocol: `noul` is `boolean` there.
    const gatewayQuestions = Object.fromEntries(
      Object.entries(questions).map(([id, q]) => [
        id,
        q.type === 'noul' ? { ...q, type: 'boolean' } : q,
      ]),
    );
    return {
      url: params.baseUrl ?? GATEWAY_URL,
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        'content-type': 'application/json',
        'ai-gateway-protocol-version': '0.0.1',
        'ai-gateway-auth-method': 'api-key',
        'ai-evaluation-model-specification-version': '4',
        'ai-model-id': gatewayModelId(params.model),
      },
      body: JSON.stringify({ state, questions: gatewayQuestions }),
    };
  }
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  // Gateway answers arrive as `{ type: 'boolean', probability }`; fold them into `noul`.
  const answers = (parsed as JevResponse).answers as unknown as Record<string, Record<string, unknown>>;
  for (const answer of Object.values(answers)) {
    if (
      answer &&
      typeof answer === 'object' &&
      answer['type'] === 'boolean' &&
      typeof answer['probability'] === 'number' &&
      !('noul' in answer)
    ) {
      answer['noul'] = answer['probability'];
      answer['type'] = 'noul';
    }
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
