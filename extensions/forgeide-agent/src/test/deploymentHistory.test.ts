import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDeploymentHistory } from '../deployment/deploymentHistory';

test('formatDeploymentHistory reports status without deployment output', () => {
  const text = formatDeploymentHistory([{
    id: 'deploy-1',
    connector: 'Terraform',
    success: true,
    startedAt: '2026-09-04T10:00:00.000Z',
    completedAt: '2026-09-04T10:01:00.000Z'
  }]);

  assert.match(text, /SUCCESS \| Terraform/);
  assert.doesNotMatch(text, /password|secret|token/i);
});