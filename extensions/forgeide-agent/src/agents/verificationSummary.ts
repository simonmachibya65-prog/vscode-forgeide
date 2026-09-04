export function summarizeVerificationResult(result: {
    passed: boolean;
    propertiesTested: string[];
    issues: string[];
}): string {
    const header = result.passed
        ? 'Verification passed.'
        : 'Verification failed.';
    const checked = result.propertiesTested.length
        ? `Checked: ${result.propertiesTested.join(', ')}`
        : 'Checked: none';
    const issues = result.issues.length
        ? `Issues:\n${result.issues.map(issue => `- ${issue}`).join('\n')}`
        : 'Issues: none';

    return `${header}\n${checked}\n${issues}`;
}
