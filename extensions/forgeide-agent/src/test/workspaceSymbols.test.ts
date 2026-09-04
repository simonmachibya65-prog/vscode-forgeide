import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolsFromText } from '../index/workspaceSymbols';

test('extractSymbolsFromText captures exported functions and types', () => {
  const text = `
export function createUser() {}
class UserService {
  static run() {}
}
export type AuthMode = 'local' | 'oauth';
const config = {};
`;

  const symbols = extractSymbolsFromText(text);
  assert.deepEqual(symbols, ['createUser', 'UserService', 'run', 'AuthMode']);
});
