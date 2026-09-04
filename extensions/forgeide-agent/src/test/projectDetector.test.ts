import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseEnvExample, createDatabasePlan, createDeploymentPlan, detectMigrationCommand, detectProjectEnvironment } from '../environment/projectDetector';

test('detectProjectEnvironment identifies stack, database, and deployment evidence', () => {
  const environment = detectProjectEnvironment([
    { path: 'package.json', content: JSON.stringify({
      dependencies: { next: '^1.0.0', '@prisma/client': '^1.0.0' },
      scripts: { test: 'vitest', build: 'next build' }
    }) },
    { path: 'package-lock.json' },
    { path: 'prisma/schema.prisma' },
    { path: 'Dockerfile' }
  ]);

  assert.equal(environment.packageManager, 'npm');
  assert.deepEqual(environment.frameworks, ['Next.js']);
  assert.deepEqual(environment.databases, ['Prisma']);
  assert.deepEqual(environment.deploymentTargets, ['Docker']);
  assert.deepEqual(environment.scripts, ['test', 'build']);
  assert.match(createDatabasePlan(environment)[0], /Prisma/);
  assert.match(createDatabaseEnvExample(environment), /DATABASE_URL=postgresql/);
  assert.match(createDatabaseEnvExample(environment), /Never commit real credentials/);
  assert.deepEqual(detectMigrationCommand(environment), {
    command: 'npx',
    args: ['prisma', 'migrate', 'deploy'],
    description: 'npx prisma migrate deploy'
  });
  assert.match(createDeploymentPlan(environment, ['Terraform']).join('\n'), /preview or staging/);
});