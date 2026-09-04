import test from 'node:test';
import assert from 'node:assert/strict';
import { rankFilesForTask } from '../specs/taskFileRanking';

test('rankFilesForTask prefers exact term matches and filters ignored paths', () => {
  const files = [
    { path: 'src/feature.ts', content: 'console.log("hello world")' },
    { path: 'src/auth.ts', content: 'export function loginUser() {}' },
    { path: '.kiro/specs/ignored.ts', content: 'feature login user' },
    { path: 'src/reports.ts', content: 'report scheduling logic' },
  ];

  const ranked = rankFilesForTask({
    title: 'Login user flow',
    detail: 'Add login and auth handling for the user sign in flow.'
  }, files);

  assert.deepEqual(ranked.map(f => f.path), ['src/auth.ts']);
});
