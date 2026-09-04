/**
 * EARS (Easy Approach to Requirements Syntax) has five canonical sentence
 * shapes. This module checks generated acceptance criteria actually follow
 * one of them, so a spec doesn't silently drift into vague prose the way
 * freeform LLM output tends to.
 */

export type EarsPattern = 'ubiquitous' | 'event' | 'state' | 'unwanted' | 'optional' | 'unrecognized';

export interface EarsCheckResult {
    line: string;
    pattern: EarsPattern;
    valid: boolean;
}

const PATTERNS: { pattern: EarsPattern; re: RegExp }[] = [
    // Event-driven: WHEN <trigger>, the system SHALL <response>
    { pattern: 'event', re: /^when\s+.+,\s*the system shall\s+.+/i },
    // Unwanted behavior: IF <condition>, THEN the system SHALL <response>
    { pattern: 'unwanted', re: /^if\s+.+,\s*then the system shall\s+.+/i },
    // State-driven: WHILE <state>, the system SHALL <response>
    { pattern: 'state', re: /^while\s+.+,\s*the system shall\s+.+/i },
    // Optional feature: WHERE <feature is included>, the system SHALL <response>
    { pattern: 'optional', re: /^where\s+.+,\s*the system shall\s+.+/i },
    // Ubiquitous: THE SYSTEM SHALL <response> (no trigger clause)
    { pattern: 'ubiquitous', re: /^the system shall\s+.+/i }
];

export function checkLine(line: string): EarsCheckResult {
    const trimmed = line.trim().replace(/^[-*\d.)\s]+/, ''); // strip list bullets/numbers
    if (!trimmed) return { line, pattern: 'unrecognized', valid: false };

    for (const { pattern, re } of PATTERNS) {
        if (re.test(trimmed)) return { line, pattern, valid: true };
    }
    return { line, pattern: 'unrecognized', valid: false };
}

export interface EarsValidationSummary {
    total: number;
    valid: number;
    invalidLines: string[];
}

/** Scans a requirements markdown block for lines that look like acceptance criteria. */
export function validateRequirements(markdown: string): EarsValidationSummary {
    const candidateLines = markdown
        .split('\n')
        .filter(l => /^\s*[-*\d]/.test(l)) // bullet or numbered lines only
        .filter(l => /shall|when|if|while|where/i.test(l)); // looks like a requirement, not a story

    const results = candidateLines.map(checkLine);
    return {
        total: results.length,
        valid: results.filter(r => r.valid).length,
        invalidLines: results.filter(r => !r.valid).map(r => r.line.trim())
    };
}
