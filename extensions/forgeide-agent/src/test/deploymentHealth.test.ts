import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHealthUrl } from '../deployment/deploymentHealth';

test('validateHealthUrl only accepts HTTP and HTTPS endpoints', () => {
  assert.equal(validateHealthUrl('https://example.com/health')?.hostname, 'example.com');
  assert.equal(validateHealthUrl('file:///etc/passwd'), undefined);
  assert.equal(validateHealthUrl('not a url'), undefined);
});