/**
 * CiviFix AI - Live HTTP Bridge Integration Test Suite
 * Phase 7: Tests live network contracts and zero-trust Firebase Auth guards
 * across Express gateway endpoints without depending on external credentials.
 */

import assert from 'node:assert';
import http from 'node:http';
import { parseImagePayload } from '../src/server/civicVisionHelpers.js';

console.log('--- RUNNING CIVIFIX AI PHASE 7 HTTP BRIDGE INTEGRATION TEST SUITE ---');

let passedTests = 0;
let totalTests = 0;

function test(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res && typeof (res as any).then === 'function') {
      return (res as Promise<void>)
        .then(() => {
          console.log(`  ✓ ${name}`);
          passedTests++;
        })
        .catch((err) => {
          console.error(`  ✗ ${name}`);
          console.error(`    Error:`, err.message);
          throw err;
        });
    }
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error:`, err.message);
    throw err;
  }
}

function makeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    timeoutMs?: number;
  } = {}
): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      timeout: options.timeoutMs || 25000,
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsedData: any = null;
        try {
          parsedData = JSON.parse(data);
        } catch {
          parsedData = data;
        }
        resolve({
          status: res.statusCode || 0,
          data: parsedData,
          raw: data,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP request to ${url} timed out`));
    });

    if (options.body !== undefined) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runSuite() {
  process.env.CIVIFIX_NO_LISTEN = '1';
  const { sanitizeConversationHistory, buildCivicSystemInstruction } = await import('../server.js');

  const targetPort = Number(process.env.PORT) || 3000;
  const baseUrl = `http://127.0.0.1:${targetPort}`;

  // 1. Public Health Check
  await test('GET /api/health responds with 200 and sanitized service readiness without leaking keys', async () => {
    const res = await makeRequest(`${baseUrl}/api/health`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    assert.strictEqual(res.data.status, 'healthy');
    assert.strictEqual(res.data.service, 'CiviFix AI Gateway');
    assert(typeof res.data.uptimeSeconds === 'number');
    assert(typeof res.data.timestamp === 'string');
    assert(res.data.services !== undefined);
    assert(typeof res.data.services.opencvInspection === 'object');
    assert(typeof res.data.services.geminiTriage === 'object');
    assert(typeof res.data.services.groqVision === 'object');
    assert(typeof res.data.services.openStreetMap === 'object');

    const jsonStr = JSON.stringify(res.data);
    assert(!jsonStr.includes('AIzaSy'), 'Firebase or Maps API key must never be leaked');
    assert(!jsonStr.includes('GEMINI_API_KEY'), 'Gemini API key env name/value must never be leaked');
  });

  // 2. Zero-Trust Firebase Auth Middleware Enforcement across Protected Endpoints
  const protectedEndpoints: Array<{ method: 'GET' | 'POST'; path: string; body?: any }> = [
    { method: 'POST', path: '/api/image/inspect', body: { photoBase64: '' } },
    { method: 'GET', path: '/api/maps/reverse-geocode?lat=17.385&lng=78.4867' },
    { method: 'POST', path: '/api/gemini/analyze-issue', body: { description: 'Pothole' } },
    { method: 'POST', path: '/api/groq/validate-civic-image', body: { photoBase64: '' } },
    { method: 'POST', path: '/api/gemini/chat', body: { message: 'How do I report a pothole?' } },
    { method: 'POST', path: '/api/civic/visualize-improvement', body: { photoBase64: '' } },
    { method: 'POST', path: '/api/admin/verify', body: {} },
  ];

  for (const ep of protectedEndpoints) {
    await test(`${ep.method} ${ep.path.split('?')[0]} rejects unauthenticated callers with 401`, async () => {
      const res = await makeRequest(`${baseUrl}${ep.path}`, {
        method: ep.method,
        body: ep.body,
      });
      assert.strictEqual(res.status, 401, `Expected 401 for ${ep.path}, got ${res.status}`);
      assert(typeof res.data?.error === 'string' && res.data.error.length > 0);
    });
  }

  await test('Protected endpoints reject malformed/forged Bearer tokens with 401', async () => {
    const res = await makeRequest(`${baseUrl}/api/admin/verify`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer forged-invalid-jwt-token-1234567890',
      },
      body: {},
    });
    assert.strictEqual(res.status, 401, `Expected 401 for forged token, got ${res.status}`);
    assert.strictEqual(res.data.authorized ?? false, false);
  });

  // 3. Server Helper Contracts (Payload validation & Chat sanitization)
  test('parseImagePayload enforces image MIME headers and strips Data URI prefixes', () => {
    assert.strictEqual(parseImagePayload('data:application/pdf;base64,JVBERi0xLjQK'), null);
    assert.strictEqual(parseImagePayload(''), null);
    const ok = parseImagePayload('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    assert(ok !== null && ok.mimeType === 'image/jpeg' && ok.cleanBase64 === '/9j/4AAQSkZJRg==');
  });

  test('sanitizeConversationHistory and buildCivicSystemInstruction enforce safe multi-turn formatting', () => {
    const formatted = sanitizeConversationHistory([
      { sender: 'assistant', text: 'Hello!' },
      { sender: 'user', text: 'Road issue' },
      { sender: 'assistant', text: 'Tell me more' },
    ]);
    assert.strictEqual(formatted.length, 2);
    assert.strictEqual(formatted[0].role, 'user');
    assert.strictEqual(formatted[1].role, 'model');

    const prompt = buildCivicSystemInstruction('en');
    assert(prompt.includes('CiviFix AI'));
  });

  console.log(`\nAll ${passedTests} / ${totalTests} Phase 7 HTTP bridge tests passed successfully!`);
  process.exit(0);
}

runSuite().catch((err) => {
  console.error('\nHTTP Bridge test suite encountered an unhandled error:', err);
  process.exit(1);
});
