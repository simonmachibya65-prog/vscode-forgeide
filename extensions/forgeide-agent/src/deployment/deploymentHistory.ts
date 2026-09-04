import * as fs from 'fs/promises';
import * as path from 'path';

export interface DeploymentRecord {
    id: string;
    connector: string;
    success: boolean;
    startedAt: string;
    completedAt: string;
}

export function formatDeploymentHistory(records: DeploymentRecord[]): string {
    if (!records.length) return 'No deployment history.';
    return records.map(record =>
        `${record.success ? 'SUCCESS' : 'FAILED'} | ${record.connector} | ${record.completedAt} | ${record.id}`
    ).join('\n');
}

export class DeploymentHistoryStore {
    private readonly filePath: string;

    constructor(workspaceRoot: string) {
        this.filePath = path.join(workspaceRoot, '.forgeide', 'deployments.json');
    }

    async list(): Promise<DeploymentRecord[]> {
        try {
            const raw = await fs.readFile(this.filePath, 'utf8');
            const records = JSON.parse(raw);
            return Array.isArray(records) ? records : [];
        } catch {
            return [];
        }
    }

    async record(input: Omit<DeploymentRecord, 'id'>): Promise<DeploymentRecord> {
        const record: DeploymentRecord = {
            ...input,
            id: `deploy-${Date.now()}`
        };
        const records = [record, ...(await this.list())].slice(0, 50);
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify(records, null, 2) + '\n', 'utf8');
        return record;
    }
}