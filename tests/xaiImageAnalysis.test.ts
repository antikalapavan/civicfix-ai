import assert from 'node:assert/strict';
import { resolveGroqApiKey, resolveGroqModel, requestGroqCivicImageAnalysis, parseGroqAnalysis } from '../src/server/xaiVision.js';

const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/';
const analysis = {
  decision: 'VALID_CIVIC_ISSUE', isCivicIssue: true, issueDetected: 'Road pothole',
  detectedIssueType: 'Pothole', primaryCategory: 'Potholes', visualSubType: 'Pothole',
  suggestedSeverity: 'Medium', severityReason: 'The road defect may affect traffic.',
  shortExplanation: 'A pothole is visible in the road.', suggestedTitle: 'Road pothole',
  suggestedDescription: 'A pothole is visible in the road surface.', confidenceLevel: 'High',
  confidencePercent: 88, detectedObjects: ['road', 'pothole'], visibleObservations: ['Dark road cavity'],
  aiAssumptions: [], visualEvidence: 'A cavity is visible in the asphalt.',
  potentialPublicImpact: 'It may affect road safety.', explanation: 'The image shows a pothole.',
  recommendedActions: ['Repair the road surface.'], safetyPrecautions: 'Stay clear of traffic.',
  defectBoundingBoxes: [],
};

assert.equal(resolveGroqApiKey({ GROQ_API_KEY: '  secret-value  ' }), 'secret-value');
assert.equal(resolveGroqApiKey({ GROQ_API_KEY: 'YOUR_GROQ_API_KEY' }), null);
assert.equal(resolveGroqModel({}), 'qwen/qwen3.8-27b');
assert.equal(resolveGroqModel({ GROQ_MODEL: 'groq-test' }), 'groq-test');

let captured: any;
const result = await requestGroqCivicImageAnalysis({
  apiKey: 'test-key', model: 'grok-test', imageDataUrl: image, prompt: 'Analyze this civic issue.',
  fetcher: async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }), { status: 200 });
  },
});
assert.equal(result.primaryCategory, 'Potholes');
assert.equal(result.decision, 'VALID_CIVIC_ISSUE');
assert.equal(result.requiresHumanReview, false);
assert.equal(result.suggestedSeverity, 'Medium');
assert.equal(parseGroqAnalysis(JSON.stringify({ ...analysis, decision: 'valid', suggestedSeverity: 'High' })).decision, 'VALID_CIVIC_ISSUE');
assert.equal(parseGroqAnalysis(JSON.stringify({ ...analysis, '  "primaryCategory': 'Potholes' })).primaryCategory, 'Potholes');
assert.equal(captured.model, 'grok-test');
assert.equal(captured.messages[0].content[0].type, 'text');
assert.equal(captured.messages[0].content[1].type, 'image_url');
assert.equal(captured.messages[0].content[1].image_url.url, image);
assert.equal(captured.response_format.type, 'json_object');

await assert.rejects(
  requestGroqCivicImageAnalysis({
    apiKey: 'test-key', model: 'grok-test', imageDataUrl: image, prompt: 'x',
    fetcher: async () => new Response('', { status: 401 }),
  }),
  (err: any) => err.code === 'AUTHENTICATION_FAILED'
);
await assert.rejects(
  requestGroqCivicImageAnalysis({
    apiKey: 'test-key', model: 'grok-test', imageDataUrl: image, prompt: 'x',
    fetcher: async () => { throw Object.assign(new Error('network down'), { name: 'FetchError' }); },
  }),
  (err: any) => err.code === 'NETWORK_ERROR'
);
await assert.rejects(
  requestGroqCivicImageAnalysis({
    apiKey: 'test-key', model: 'grok-test', imageDataUrl: image, prompt: 'x',
    fetcher: async () => new Response(JSON.stringify({ error: { type: 'invalid_api_key', message: 'Incorrect API key provided.' } }), { status: 400 }),
  }),
  (err: any) => err.code === 'INVALID_REQUEST' && err.providerType === 'invalid_api_key' && /Incorrect API key/.test(err.message)
);
console.log('Groq image analysis tests passed');
