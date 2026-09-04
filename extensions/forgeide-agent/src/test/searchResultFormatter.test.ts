import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSearchResultText, buildSearchQuickPickItems } from '../chat/searchResultFormatter';

test('formatSearchResultText formats workspace search output', () => {
  const text = formatSearchResultText('login', [
    { path: 'src/auth.ts', line: 8, snippet: 'loginUser()' }
  ]);

  assert.match(text, /src\/auth\.ts:8/);
  assert.match(text, /loginUser/);
});

test('buildSearchQuickPickItems gives a no-results fallback', () => {
  const items = buildSearchQuickPickItems('missing', []);
  assert.equal(items[0].label, 'No matches for "missing"');
});
