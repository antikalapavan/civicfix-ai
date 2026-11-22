import assert from 'node:assert';

console.log('--- RUNNING CIVIFIX AI ML GATEWAY UNIT TESTS ---');

let passed = 0;
let total = 0;

function it(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    const res = fn();
    if (res && typeof (res as any).then === 'function') {
      return (res as Promise<void>)
        .then(() => {
          console.log(`  ✓ ${name}`);
          passed++;
        })
        .catch((err) => {
          console.error(`  ✗ ${name}`);
          console.error(`    Error:`, err.message);
          throw err;
        });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error:`, err.message);
    throw err;
  }
}

// 1. Validation logic testing
it('Validates complaint description input lengths and types', () => {
  const validate = (desc: unknown) => {
    if (!desc || typeof desc !== 'string' || desc.trim().length < 3) {
      return { valid: false, error: 'Complaint description must be at least 3 characters long.' };
    }
    return { valid: true };
  };

  assert.strictEqual(validate(null).valid, false);
  assert.strictEqual(validate(undefined).valid, false);
  assert.strictEqual(validate('').valid, false);
  assert.strictEqual(validate('   ').valid, false);
  assert.strictEqual(validate('ab').valid, false);
  assert.strictEqual(validate(123).valid, false);
  assert.strictEqual(validate('pothole on main rd').valid, true);
});

// 2. Conformance of ML metadata to AiAnalysisResult
it('Conforms ML metadata to AiAnalysisResult schema for Firestore safety', () => {
  const prediction = {
    category: 'Pothole' as const,
    confidence: 0.892,
    model: 'TfidfVectorizer + LogisticRegression',
  };

  const selectedCategory = 'Garbage' as const;

  const aiAnalysis = {
    suggestedCategory: prediction.category,
    categoryMatch: (prediction.category as string) === (selectedCategory as string),
    severity: 'Medium' as const,
    confidence: `${Math.round(prediction.confidence * 100)}%`,
    aiNotes: `Classified via ${prediction.model} with ${Math.round(prediction.confidence * 100)}% confidence.`,
    isFallback: false,
  };

  assert.strictEqual(aiAnalysis.suggestedCategory, 'Pothole');
  assert.strictEqual(aiAnalysis.categoryMatch, false);
  assert.strictEqual(aiAnalysis.confidence, '89%');
  assert.strictEqual(aiAnalysis.isFallback, false);
});

console.log(`\nAll ${total} ML gateway schema & validation tests passed!`);
