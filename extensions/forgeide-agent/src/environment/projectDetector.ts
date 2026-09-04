export interface ProjectFile {
    path: string;
    content?: string;
}

export interface ProjectEnvironment {
    packageManager: string;
    frameworks: string[];
    databases: string[];
    deploymentTargets: string[];
    scripts: string[];
}

export interface MigrationCommand {
    command: string;
    args: string[];
    description: string;
}

const databasePackages: Array<[string, string]> = [
    ['prisma', 'Prisma'],
    ['@prisma/client', 'Prisma'],
    ['typeorm', 'TypeORM'],
    ['sequelize', 'Sequelize'],
    ['mongoose', 'MongoDB'],
    ['mongodb', 'MongoDB'],
    ['pg', 'PostgreSQL'],
    ['mysql2', 'MySQL'],
    ['better-sqlite3', 'SQLite'],
    ['sqlite3', 'SQLite'],
    ['redis', 'Redis'],
    ['ioredis', 'Redis'],
    ['firebase', 'Firebase'],
    ['@supabase/supabase-js', 'Supabase']
];

export function detectProjectEnvironment(files: ProjectFile[]): ProjectEnvironment {
    const names = new Set(files.map(file => file.path.toLowerCase()));
    const packageFile = files.find(file => file.path.toLowerCase() === 'package.json');
    let dependencies: Record<string, unknown> = {};
    let scripts: string[] = [];

    if (packageFile?.content) {
        try {
            const packageJson = JSON.parse(packageFile.content);
            dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
            scripts = Object.keys(packageJson.scripts ?? {});
        } catch {
            // Invalid manifests are reported through the normal Problems view.
        }
    }

    const frameworks: string[] = [];
    for (const [dependency, framework] of [
        ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['@angular/core', 'Angular'],
        ['svelte', 'Svelte'], ['express', 'Express'], ['fastify', 'Fastify'], ['nest', 'NestJS']
    ]) {
        if (dependency in dependencies) frameworks.push(framework);
    }

    const databases = new Set<string>();
    for (const [dependency, database] of databasePackages) {
        if (dependency in dependencies) databases.add(database);
    }
    if ([...names].some(name => /(^|\/)schema\.prisma$/.test(name))) databases.add('Prisma');
    if ([...names].some(name => /(^|\/)(docker-compose|compose)\.(ya?ml)$/.test(name))) databases.add('Docker Compose database');
    if ([...names].some(name => /(^|\/)(supabase|firebase)\//.test(name))) databases.add('Managed backend');

    const deploymentTargets: string[] = [];
    if (names.has('dockerfile') || [...names].some(name => name.endsWith('/dockerfile'))) deploymentTargets.push('Docker');
    if (names.has('vercel.json')) deploymentTargets.push('Vercel');
    if (names.has('netlify.toml')) deploymentTargets.push('Netlify');
    if ([...names].some(name => name.endsWith('.tf'))) deploymentTargets.push('Terraform');
    if (names.has('serverless.yml') || names.has('serverless.yaml')) deploymentTargets.push('Serverless');

    const packageManager = names.has('pnpm-lock.yaml')
        ? 'pnpm'
        : names.has('yarn.lock')
            ? 'yarn'
            : names.has('bun.lockb') || names.has('bun.lock')
                ? 'bun'
                : names.has('package-lock.json')
                    ? 'npm'
                    : 'unknown';

    return { packageManager, frameworks, databases: [...databases], deploymentTargets, scripts };
}

export function createDatabasePlan(environment: ProjectEnvironment): string[] {
    if (!environment.databases.length) {
        return [
            'No database technology detected.',
            'Choose a database and record the decision in the project design.',
            'Create separate development, preview, and production credentials.'
        ];
    }

    return [
        `Detected database stack: ${environment.databases.join(', ')}.`,
        'Verify connection configuration and ensure secrets are stored outside source control.',
        'Review schema and migration files before applying changes.',
        'Create isolated development, preview, and production database environments.',
        'Run migrations in preview and execute smoke tests before production approval.',
        'Create a backup and require explicit approval for destructive production migrations.'
    ];
}

export function createDatabaseEnvExample(environment: ProjectEnvironment): string {
    const database = environment.databases[0] ?? 'PostgreSQL';
    const values: Record<string, string> = {
        Prisma: 'postgresql://USER:PASSWORD@localhost:5432/DATABASE',
        PostgreSQL: 'postgresql://USER:PASSWORD@localhost:5432/DATABASE',
        MySQL: 'mysql://USER:PASSWORD@localhost:3306/DATABASE',
        MongoDB: 'mongodb://USER:PASSWORD@localhost:27017/DATABASE',
        SQLite: 'file:./dev.db',
        Redis: 'redis://localhost:6379',
        Firebase: 'replace-with-firebase-project-config',
        Supabase: 'postgresql://USER:PASSWORD@HOST:5432/DATABASE'
    };
    const value = values[database] ?? 'replace-with-database-connection-string';
    return [
        '# ForgeIDE database configuration template',
        '# Replace placeholders locally. Never commit real credentials.',
        `DATABASE_URL=${value}`,
        '',
        '# Separate values should be used for development, preview, and production.'
    ].join('\n');
}

export function detectMigrationCommand(environment: ProjectEnvironment): MigrationCommand | undefined {
    const packageManager = environment.packageManager === 'unknown' ? 'npm' : environment.packageManager;
    const runScript = (script: string): MigrationCommand => ({
        command: packageManager,
        args: ['run', script],
        description: `${packageManager} run ${script}`
    });

    const script = environment.scripts.find(name => /^(db:)?migrate(:deploy)?$/i.test(name));
    if (script) return runScript(script);
    if (environment.databases.includes('Prisma')) {
        return { command: 'npx', args: ['prisma', 'migrate', 'deploy'], description: 'npx prisma migrate deploy' };
    }
    if (environment.databases.includes('TypeORM')) {
        return { command: 'npx', args: ['typeorm', 'migration:run'], description: 'npx typeorm migration:run' };
    }
    if (environment.databases.includes('Sequelize')) {
        return { command: 'npx', args: ['sequelize-cli', 'db:migrate'], description: 'npx sequelize-cli db:migrate' };
    }
    return undefined;
}

export function createDeploymentPlan(environment: ProjectEnvironment, connectors: string[]): string[] {
    const plan = [
        `Package manager: ${environment.packageManager}.`,
        `Frameworks: ${environment.frameworks.length ? environment.frameworks.join(', ') : 'not detected'}.`,
        `Deployment targets: ${environment.deploymentTargets.length ? environment.deploymentTargets.join(', ') : 'none detected'}.`,
        `Infrastructure connectors: ${connectors.length ? connectors.join(', ') : 'none detected'}.`,
        environment.scripts.includes('build') ? 'Build script detected: run the production build.' : 'Add and verify a production build command.',
        environment.scripts.some(script => /test/i.test(script)) ? 'Test script detected: run the test suite before deployment.' : 'Add and verify a test command before deployment.',
        'Deploy to a preview or staging environment first.',
        'Run health checks and smoke tests against the preview environment.',
        'Require explicit production approval and record the deployment result.',
        'Keep a rollback target and preserve deployment logs.'
    ];
    if (environment.databases.length) {
        plan.splice(4, 0, `Database: ${environment.databases.join(', ')}; review migrations and backups before deployment.`);
    }
    return plan;
}