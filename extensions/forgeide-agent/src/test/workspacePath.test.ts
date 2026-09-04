import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { resolveWorkspacePath } from '../security/workspacePath';

test('resolveWorkspacePath keeps model writes inside the workspace', () => {
  const root = path.resolve('workspace');

  assert.equal(resolveWorkspacePath(root, 'src/index.ts'), path.join(root, 'src', 'index.ts'));
  assert.equal(resolveWorkspacePath(root, '../outside.txt'), undefined);
  assert.equal(resolveWorkspacePath(root, path.join(root, 'outside.txt')), undefined);
});