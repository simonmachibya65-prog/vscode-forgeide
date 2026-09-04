import * as http from 'http';
import * as https from 'https';

export interface DeploymentHealthResult {
    url: string;
    ok: boolean;
    statusCode?: number;
    latencyMs: number;
    error?: string;
}

export function validateHealthUrl(value: string): URL | undefined {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
        return url;
    } catch {
        return undefined;
    }
}

export function checkDeploymentHealth(value: string, timeoutMs = 10_000): Promise<DeploymentHealthResult> {
    const url = validateHealthUrl(value);
    if (!url) {
        return Promise.resolve({ url: value, ok: false, latencyMs: 0, error: 'Only valid HTTP and HTTPS URLs are supported.' });
    }

    return new Promise(resolve => {
        const startedAt = Date.now();
        const client = url.protocol === 'https:' ? https : http;
        const request = client.get(url, response => {
            response.resume();
            response.on('end', () => resolve({
                url: url.toString(),
                ok: (response.statusCode ?? 500) < 400,
                statusCode: response.statusCode,
                latencyMs: Date.now() - startedAt
            }));
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Health check timed out.')));
        request.on('error', error => resolve({
            url: url.toString(),
            ok: false,
            latencyMs: Date.now() - startedAt,
            error: error.message
        }));
    });
}