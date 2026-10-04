// A stand-in for src/domain/quality-checks.ts (written in parallel): each test file mocks the module with
//   vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);
// and drives `fakeChecks.impl` per test.
import type { BoundaryRule, Defect } from '../../../src/features/quality/api';
import type { QualityInput } from '../../../src/domain/quality-types';

export const FAKE_BOUNDARY_RULES: BoundaryRule[] = [
    { id: 'minors', title: 'No sexual content with minors', patterns: ['both:child&&sex', 'ребёнок'], enabled: true },
];

export const fakeChecks = {
    impl: ((): Defect[] => []) as (input: QualityInput) => Defect[],
    calls: [] as QualityInput[],
    reset(): void {
        fakeChecks.impl = () => [];
        fakeChecks.calls = [];
    },
};

export const fakeChecksModule = {
    runFreeChecks(input: QualityInput): Defect[] {
        fakeChecks.calls.push(input);
        return fakeChecks.impl(input).map((defect) => ({ ...defect }));
    },
    DEFAULT_BOUNDARY_RULES: FAKE_BOUNDARY_RULES,
};

// The same names as the real module (for runs that alias the module instead of mocking it).
export const runFreeChecks = fakeChecksModule.runFreeChecks;
export const DEFAULT_BOUNDARY_RULES = FAKE_BOUNDARY_RULES;
