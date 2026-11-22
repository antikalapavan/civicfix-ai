import assert from 'node:assert';
import http from 'node:http';
import { searchCivicKnowledge } from '../src/data/civicKnowledge.js';

console.log('\n--- RUNNING CIVIFIX AI MULTI-TURN MULTILINGUAL CHATBOT TEST SUITE ---');

let passedTests = 0;
let totalTests = 0;

function test(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res
        .then(() => {
          console.log(`  ✓ ${name}`);
          passedTests++;
        })
        .catch((err) => {
          console.error(`  ✗ ${name}`);
          console.error(`    Error:`, err.message);
          throw err;
        });
    } else {
      console.log(`  ✓ ${name}`);
      passedTests++;
    }
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error:`, err.message);
    throw err;
  }
}

const PORT = Number(process.env.PORT) || 3000;
const baseUrl = `http://127.0.0.1:${PORT}`;

function makeRequest(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: any }
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const postData = options.body ? JSON.stringify(options.body) : '';

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...(options.headers || {}),
        },
        timeout: 8000,
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          let data: any = {};
          try {
            data = JSON.parse(rawData);
          } catch {
            data = { rawText: rawData };
          }
          resolve({ status: res.statusCode || 500, data });
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP request timed out after 8s'));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runSuite() {
  process.env.CIVIFIX_NO_LISTEN = '1';
  const {
    sanitizeConversationHistory,
    buildCivicSystemInstruction,
    SUPPORTED_CHAT_LANGUAGES,
  } = await import('../server.js');

  // TEST 1: Empty history conversion
  test('1. Empty conversation history converts cleanly to empty array', () => {
    const formatted = sanitizeConversationHistory([]);
    assert.deepStrictEqual(formatted, [], 'Empty history converts to empty array');
  });

  // TEST 2: Second message preserves previous conversation history
  test('2. Multi-turn history preserves chronological user/model structure', () => {
    const history = [
      { role: 'user' as const, text: 'How do I report a pothole?' },
      { role: 'model' as const, text: 'You can report a pothole using the + Report screen.' },
    ];
    const formatted = sanitizeConversationHistory(history);
    assert.strictEqual(formatted.length, 2);
    assert.strictEqual(formatted[0].role, 'user');
    assert.strictEqual(formatted[0].parts[0].text, 'How do I report a pothole?');
    assert.strictEqual(formatted[1].role, 'model');
  });

  // TEST 3: Correct Gemini role and parts conversion + coalescing
  test('3. Correct Gemini role and parts conversion for both user and model', () => {
    const input = [
      { role: 'user', text: 'Where is the trash bin?' },
      { role: 'model', text: 'The green bin is for wet waste.' },
      { sender: 'assistant', text: 'The blue bin is for dry recyclables.' },
    ];
    const result = sanitizeConversationHistory(input);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].role, 'user');
    assert.deepStrictEqual(result[0].parts, [{ text: 'Where is the trash bin?' }]);
    assert.strictEqual(result[1].role, 'model');
    assert(result[1].parts[0].text.includes('green bin'));
    assert(result[1].parts[0].text.includes('blue bin'));
  });

  // TEST 4: Trailing user message is dropped so sendMessage appends exactly once
  test('4. Trailing user message is dropped from history so sendMessage appends exactly once', () => {
    const currentMessage = 'Where can I drop off e-waste?';
    const preAppendedHistory = [
      { role: 'user', text: 'Hello' },
      { role: 'model', text: 'Hi! I am CiviFix.' },
      { role: 'user', text: currentMessage },
    ];

    const result = sanitizeConversationHistory(preAppendedHistory, currentMessage);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[result.length - 1].role, 'model');
  });

  // TEST 5: History length capping preserves most recent turns
  test('5. Long conversation history is safely bounded to the 10 most recent turns', () => {
    const longHistory: Array<{ role: 'user' | 'model'; text: string }> = [];
    for (let i = 1; i <= 12; i++) {
      longHistory.push({ role: 'user', text: `User turn ${i}` });
      longHistory.push({ role: 'model', text: `Model turn ${i}` });
    }
    const result = sanitizeConversationHistory(longHistory);
    assert.strictEqual(result.length, 10);
    assert.strictEqual(result[0].role, 'user');
    assert.strictEqual(result[result.length - 1].role, 'model');
  });

  // TEST 6: Follow-up questions retaining context in offline fallback
  test('6. Multi-turn follow-up retaining context in searchCivicKnowledge', () => {
    const history = [
      { sender: 'user', text: 'Where can I take my old phone?' },
      { sender: 'assistant', text: 'Electronic waste should be dropped off at authorized ward e-waste centers.' },
    ];
    const followUp = searchCivicKnowledge('What about its battery?', history);
    assert(followUp !== null);
    assert(
      followUp.title.toLowerCase().includes('waste') ||
        followUp.answer.toLowerCase().includes('batter') ||
        followUp.answer.toLowerCase().includes('e-waste')
    );
  });

  // TEST 7: All five supported languages generate native script directives
  test('7. All five supported languages generate native script directives', () => {
    const languages = ['en', 'hi', 'te', 'ta', 'kn'];
    for (const lang of languages) {
      assert(SUPPORTED_CHAT_LANGUAGES[lang] !== undefined, `Language ${lang} must be configured`);
      const instruction = buildCivicSystemInstruction(lang);
      assert(instruction.includes(SUPPORTED_CHAT_LANGUAGES[lang].name), `Instruction must mention ${lang}`);
      assert(instruction.includes(SUPPORTED_CHAT_LANGUAGES[lang].nativeName), `Instruction must mention native name for ${lang}`);
    }
  });

  // TEST 8: System instructions enforce civic boundaries & prevent hallucinations
  test('8. System instructions strictly enforce civic boundaries and prevent hallucinations', () => {
    const instruction = buildCivicSystemInstruction('en');
    assert(instruction.includes('NEVER invent government schemes'));
    assert(instruction.includes('Do NOT claim that a complaint has been submitted'));
    assert(instruction.includes('Focus strictly on civic issues'));
    assert(instruction.includes('2-Bin 1-Bag'));
  });

  // TEST 9: Live HTTP /api/gemini/chat rejects unauthenticated callers (zero-trust guard)
  await test('9. POST /api/gemini/chat requires verified Firebase Bearer authentication', async () => {
    const unauthRes = await makeRequest(`${baseUrl}/api/gemini/chat`, {
      method: 'POST',
      body: { message: 'How do I report a pothole?' },
    });
    assert.strictEqual(unauthRes.status, 401);

    const forgedRes = await makeRequest(`${baseUrl}/api/gemini/chat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token-for-chat-test' },
      body: { message: 'How do I report a pothole?' },
    });
    assert.strictEqual(forgedRes.status, 401);
  });

  // TEST 10: Existing civic knowledge queries resolve accurately without regression
  test('10. Existing civic knowledge queries resolve accurately without regression', () => {
    const q1 = searchCivicKnowledge('How can I dispose of electronic waste?');
    assert(q1 !== null && q1.answer.includes('e-waste'));

    const q2 = searchCivicKnowledge('Water leakage on main road');
    assert(q2 !== null && q2.answer.includes('Water'));

    const q3 = searchCivicKnowledge('Blocked stormwater drain overflow');
    assert(q3 !== null && q3.answer.includes('Drainage'));
  });

  console.log(`\nAll ${passedTests} / ${totalTests} Multi-Turn Multilingual Chatbot test cases passed successfully!`);
  process.exit(0);
}

runSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
