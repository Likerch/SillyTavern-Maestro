// Every built-in agent's default instruction (release 1.29) is found, as is, in the system message its module sends:
// the user's instruction replaces exactly that text. A module that rewrites its prompt and forgets the constant fails
// here instead of silently ignoring the player's instruction.
import { describe, expect, it } from 'vitest';
import { buildCheckMessages, CONTRADICTIONS_INSTRUCTION } from '../../../src/domain/contradictions-ai';
import { RECAP_INSTRUCTION_HEAD, recapPrompt } from '../../../src/domain/chronicle-recap';
import { buildSceneMessages, SCENE_INSTRUCTION_HEAD } from '../../../src/domain/director-scene';
import { buildCompareMessages, DOSSIER_COMPARE_INSTRUCTION } from '../../../src/domain/dossier-compare';
import { buildExtractMessages as livingMessages, LIVING_INSTRUCTION } from '../../../src/domain/living-extract';
import { LORE_PASSPORT_INSTRUCTION, passportGenMessages } from '../../../src/domain/lore-passport-gen';
import {
    buildExtractMessages as mechanicsMessages,
    EXTRACT_LIMITS,
    MECHANICS_EXTRACT_INSTRUCTION,
} from '../../../src/domain/mechanics-extract';
import { offscreenInstructions } from '../../../src/domain/offscreen-prompt';
import { PERSONA_INSTRUCTION_HEAD } from '../../../src/domain/persona-create';
import { AUDIT_INSTRUCTION_HEAD } from '../../../src/domain/prompt-audit-ai';
import { DEFAULT_PROMPT_LIMITS, revisionInstructions } from '../../../src/domain/revision-prompt';
import { changeMessages, WARDROBE_CHANGE_INSTRUCTION } from '../../../src/domain/wardrobe-change-model';
import { personaMessages, WARDROBE_PERSONA_INSTRUCTION } from '../../../src/domain/wardrobe-persona';
import { JUDGE_INSTRUCTION_HEAD } from '../../../src/features/quality/judge';

describe('built-in agents: default instructions are in the real requests', () => {
    it('whole texts', () => {
        expect(buildCheckMessages({ key: 'k', statement: 's', entities: [], against: [], hints: [] })[0]?.content).toBe(
            CONTRADICTIONS_INSTRUCTION,
        );
        expect(buildCompareMessages('Мира', [], [])[0]?.content).toBe(DOSSIER_COMPARE_INSTRUCTION);
        expect(passportGenMessages({ name: 'Мира', kind: null, content: 'x' })[0]?.content).toBe(
            LORE_PASSPORT_INSTRUCTION,
        );
        expect(changeMessages({ people: [], said: [], excerpt: '' })[0]?.content).toBe(WARDROBE_CHANGE_INSTRUCTION);
        expect(personaMessages({ name: 'Кай', current: '', excerpt: '' })[0]?.content).toBe(
            WARDROBE_PERSONA_INSTRUCTION,
        );
        expect(revisionInstructions(DEFAULT_PROMPT_LIMITS.maxChanges)).toContain('12');
        expect(offscreenInstructions().length).toBeGreaterThan(200);
    });

    it('texts with a setting filled in', () => {
        const living = livingMessages({ messages: [], provisional: [], known: [], max: 3 })[0]?.content;
        expect(living).toBe(LIVING_INSTRUCTION.replace('{max}', '3'));
        const mechanics = mechanicsMessages({ targets: [], reply: 'x' })[0]?.content ?? '';
        expect(
            mechanics.startsWith(MECHANICS_EXTRACT_INSTRUCTION.replace('{max}', String(EXTRACT_LIMITS.changes))),
        ).toBe(true);
    });

    it('fixed openings of texts that carry names, languages or candidates', () => {
        expect(
            recapPrompt({ chapters: [], long: [], recent: [] }, 'ru').system.startsWith(RECAP_INSTRUCTION_HEAD),
        ).toBe(true);
        expect(
            buildSceneMessages({ text: 'x', candidates: ['dialogue', 'combat'] })[0]?.content.startsWith(
                SCENE_INSTRUCTION_HEAD,
            ),
        ).toBe(true);
        for (const head of [PERSONA_INSTRUCTION_HEAD, AUDIT_INSTRUCTION_HEAD, JUDGE_INSTRUCTION_HEAD]) {
            expect(head.split('\n').length).toBeGreaterThanOrEqual(2);
        }
    });
});
