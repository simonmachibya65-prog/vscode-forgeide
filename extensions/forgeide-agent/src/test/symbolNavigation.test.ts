import test from 'node:test';
import assert from 'node:assert/strict';
import { findWorkspaceSymbols } from '../index/workspaceSymbols';

test('findWorkspaceSymbols ranks matches by symbol name and path', async () => {
  const matches = await findWorkspaceSymbols('user', [
    { path: 'src/auth.ts', content: 'export function loginUser() {}' },
    { path: 'src/user.ts', content: 'export class UserService {}' },
    { path: 'src/log.ts', content: 'function log() {}' }
  ]);

  assert.ok(matches.some((item: { path: string }) => item.path === 'src/user.ts'));
  assert.ok(matches.some((item: { path: string }) => item.path === 'src/auth.ts'));
  assert.ok(matches[0].score >= 3);
});
