import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVerificationResult } from '../agents/verificationSummary';

test('summarizeVerificationResult includes checked properties and actionable issues', () => {
  const summary = summarizeVerificationResult({
    passed: false,
    propertiesTested: ['type-safety', 'lint'],
    issues: ['[lint] ESLint reported 2 warnings', '[type-safety] TypeScript failed']
  });

  assert.match(summary, /Checked: type-safety, lint/i);
  assert.match(summary, /ESLint reported 2 warnings/i);
  assert.match(summary, /TypeScript failed/i);
});
