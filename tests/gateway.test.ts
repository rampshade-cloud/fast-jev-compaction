import { describe, expect, it } from 'vitest';
import { buildJevRequest, gatewayModelId, parseJevResponse, GATEWAY_URL } from '../src/request.js';

describe('Vercel AI Gateway provider', () => {
  it('maps model names onto gateway ids', () => {
    expect(gatewayModelId(undefined)).toBe('typesafe-ai/jev');
    expect(gatewayModelId('jev-latest')).toBe('typesafe-ai/jev');
    expect(gatewayModelId('jev')).toBe('typesafe-ai/jev');
    expect(gatewayModelId('typesafe-ai/jev')).toBe('typesafe-ai/jev');
  });

  it('builds an evaluation-model request with noul renamed to boolean', () => {
    const req = buildJevRequest(
      { apiKey: 'k', model: 'jev-latest', provider: 'gateway' },
      { goal: 'g' },
      { call_t1: { type: 'noul', instructions: 'keep?' } },
    );
    expect(req.url).toBe(GATEWAY_URL);
    expect(req.headers['ai-model-id']).toBe('typesafe-ai/jev');
    expect(req.headers['ai-evaluation-model-specification-version']).toBe('4');
    expect(req.headers['ai-gateway-protocol-version']).toBe('0.0.1');
    const body = JSON.parse(req.body);
    expect(body.questions.call_t1.type).toBe('boolean');
    expect(body.model).toBeUndefined();
  });

  it('leaves the TypeSafe request untouched by default', () => {
    const req = buildJevRequest({ apiKey: 'k' }, 's', { q: { type: 'noul', instructions: 'x' } });
    expect(req.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JSON.parse(req.body).questions.q.type).toBe('noul');
  });

  it('folds gateway boolean answers into noul', () => {
    const res = parseJevResponse(
      200,
      true,
      JSON.stringify({ answers: { call_t1: { type: 'boolean', probability: 0.83 } } }),
    );
    expect(res.answers.call_t1).toMatchObject({ type: 'noul', noul: 0.83 });
  });
});
