import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basicChat, createQualityStand, defect, sleep } from './helpers';
import type { QualityStand } from './helpers';

vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);

let env: QualityStand;

const TRACKER = '```json\n{"infoBox":"{\\"date\\":\\"1 May\\"}","characterThoughts":"[]"}\n```\n';

beforeEach(() => {
    env = createQualityStand();
    basicChat(env);
});

afterEach(async () => {
    await env.stop();
});

function setReply(text: string): void {
    const reply = env.chat[2]!;
    reply.mes = text;
    reply.swipes = [text];
    reply.swipe_id = 0;
}

describe('clean', () => {
    it('cleans junk, keeps the DES tracker block and NAI markers, journals it and says ok', async () => {
        const text = `${TRACKER}Anna smiled. <|im_end|> She waved. [nai:img:abc123]`;
        setReply(text);
        // The checks may return story text only: the tracker block is put back in front.
        env.defects(
            defect('junk', {
                quote: '<|im_end|>',
                fix: { kind: 'clean', cleaned: 'Anna smiled. She waved. [nai:img:abc123]' },
            }),
        );
        const service = env.start();
        await env.reply(2);
        const reply = env.chat[2]!;
        expect(reply.mes).toBe(`${TRACKER}Anna smiled. She waved. [nai:img:abc123]`);
        expect((reply.swipes as string[])[0]).toBe(reply.mes);
        expect(env.st.updates).toEqual([2]);
        expect(env.st.saves).toBe(1);
        const verdict = service.verdict(2)!;
        expect(verdict).toMatchObject({ ok: true, action: 'cleaned' });
        expect(verdict.defects[0]!.status).toBe('cleaned');
        expect(env.bus['reply:ok']).toEqual([{ messageIndex: 2 }]);
        expect(env.journal.records[0]).toMatchObject({ module: 'M12', kind: 'quality.junk', sourceMessage: 2 });
        expect(env.journal.records[0]!.changes[0]).toMatchObject({
            target: 'quality-text',
            before: { text },
            after: { text: reply.mes },
        });
        expect(service.stats().find((row) => row.kind === 'junk')).toMatchObject({ detected: 1, autoActions: 1 });
        expect(env.badges).toHaveLength(0);
        // The journal reads as a noun phrase, the automatic notice as what Maestro did; fixes of a turn merge.
        const proposal = env.autonomy.decisions[0]!;
        expect(proposal.title).toBe('Cleaning reply #2: service junk');
        expect(proposal.appliedNotice?.text).toBe('Cleaned reply #2: service junk.');
        expect(proposal.appliedNotice?.group).toBe('quality.applied');
        expect(proposal.appliedNotice?.groupText?.(2)).toBe('Fixed defects in replies: 2 fixes');
    });

    it('removes the quoted junk itself when the check gives no cleaned text', async () => {
        setReply('Anna smiled.<|eot_id|>');
        env.defects(defect('junk', { quote: '<|eot_id|>' }));
        env.start();
        await env.reply(2);
        expect(env.chat[2]!.mes).toBe('Anna smiled.');
    });

    it('falls back to removing the quote when the cleaned text would lose a marker', async () => {
        setReply('Anna smiled. <|im_end|> [nai:img:abc123]');
        env.defects(defect('junk', { quote: '<|im_end|>', fix: { kind: 'clean', cleaned: 'Anna smiled.' } }));
        env.start();
        await env.reply(2);
        expect(env.chat[2]!.mes).toBe('Anna smiled.  [nai:img:abc123]');
    });

    it('notifies when nothing safe can be cleaned', async () => {
        setReply('Anna smiled. <div>leak</div>');
        env.defects(defect('junk', { quote: '' }));
        const service = env.start();
        await env.reply(2);
        expect(env.chat[2]!.mes).toBe('Anna smiled. <div>leak</div>');
        expect(service.verdict(2)!.defects[0]!.status).toBe('notified');
        expect(env.badges.filter((item) => !item.removed)).toHaveLength(2);
    });

    it('an undo of the cleaning puts the text back and counts a false positive', async () => {
        const text = 'Anna smiled.<|eot_id|>';
        setReply(text);
        env.defects(defect('junk', { quote: '<|eot_id|>' }));
        const service = env.start();
        await env.reply(2);
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.chat[2]!.mes).toBe(text);
        expect(service.stats().find((row) => row.kind === 'junk')!.falsePositives).toBe(1);
        expect(env.autonomy.records).toContainEqual(['quality.junk', 'undone']);
        expect(service.verdict(2)).toBeUndefined();
    });
});

describe('auto-swipe', () => {
    beforeEach(() => {
        env.core.autonomy['quality.refusal'] = 'auto';
        env.core.autonomy['quality.userSpeech'] = 'auto';
    });

    it('swipes once with a one-shot fix note for the swipe generation only', async () => {
        env.defects(defect('refusal'), defect('repetition'));
        const service = env.start();
        await env.reply(2);
        await sleep(20);
        expect(env.st.swipes).toHaveLength(1);
        expect(env.st.swipes[0]!.message).toBe(env.chat[2]);
        expect(env.metrics.autoSwipes).toBe(1);
        const verdict = service.verdict(2)!;
        expect(verdict.action).toBe('swiped');
        expect(verdict.defects.every((item) => item.status === 'swiped')).toBe(true);
        expect(env.journal.records[0]).toMatchObject({ kind: 'quality.refusal' });
        expect(env.journal.records[0]!.changes[0]!.target).toBe('quality-swipe');
        expect(service.stats().find((row) => row.kind === 'refusal')!.autoActions).toBe(1);

        // ST swipes: the swipe generation gets the note, any later generation does not.
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'swiped' });
        await env.generate('swipe');
        const note = env.injections.get('quality_fix');
        expect(note?.text).toMatch(/^\[Fix for this reply: .*\]$/);
        expect(note?.text).toContain('no refusals');
        expect(note?.text).toContain('Do not repeat');
        expect(note).toMatchObject({ position: 1, depth: 0, role: 0 });
        await env.end();
        await env.generate('swipe');
        expect(env.injections.has('quality_fix')).toBe(false);
        await env.end();
    });

    it('allows one auto-swipe per turn: the next defective reply only notifies', async () => {
        env.defects(defect('userSpeech'));
        const service = env.start();
        await env.reply(2);
        await sleep(20);
        expect(env.st.swipes).toHaveLength(1);

        // The new swipe is defective too.
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'swiped' });
        env.chat[2]!.swipe_id = 1;
        env.chat[2]!.mes = 'Second try.';
        (env.chat[2]!.swipes as string[]).push('Second try.');
        await env.reply(2, 'swipe');
        await sleep(20);
        expect(env.st.swipes).toHaveLength(1);
        expect(service.verdict(2)!.defects[0]!.status).toBe('notified');

        // The user sends a message: a new turn has its own auto-swipe.
        await env.app.bus.emit('turn:committed', { messageIndex: 2 });
        expect(service.swipeBudget()).toBe(true);
    });

    it('waits for ST to be idle; when it never is, the defects become a notice and the turn keeps its swipe', async () => {
        env.st.allowed = false;
        env.defects(defect('refusal'));
        const service = env.start({ idleMs: 30 });
        await env.reply(2);
        await sleep(80);
        expect(env.st.swipes).toHaveLength(0);
        const verdict = service.verdict(2)!;
        expect(verdict.action).toBe('notified');
        expect(service.swipeBudget()).toBe(true);
        expect(env.badges.filter((item) => !item.removed)).toHaveLength(2);
    });

    it('does not swipe a reply that is not the last message', async () => {
        env.chat.push({ ...env.chat[1]! });
        env.defects(defect('refusal'));
        const service = env.start();
        await env.reply(2);
        expect(env.st.swipes).toHaveLength(0);
        expect(service.verdict(2)!.defects[0]!.status).toBe('notified');
    });
});

describe('continue', () => {
    it('sends /continue for a truncated reply set to «auto»', async () => {
        env.core.autonomy['quality.truncated'] = 'auto';
        env.defects(defect('truncated'));
        const service = env.start();
        await env.reply(2);
        await sleep(10);
        expect(env.st.commands).toEqual(['/continue']);
        expect(service.verdict(2)!.action).toBe('continued');
        expect(env.journal.records[0]!.changes[0]!.target).toBe('quality-continue');
    });

    it('keeps «notify» (the default) as a badge', async () => {
        env.defects(defect('truncated'));
        const service = env.start();
        await env.reply(2);
        expect(env.st.commands).toEqual([]);
        expect(service.verdict(2)!.action).toBe('notified');
    });
});

describe('repairTracker', () => {
    it('asks M3 to repair a missing tracker', async () => {
        env.medic.api = true;
        env.defects(defect('missingTracker'));
        const service = env.start();
        await env.reply(2);
        await sleep(10);
        expect(env.medic.calls).toEqual([2]);
        const verdict = service.verdict(2)!;
        expect(verdict.defects[0]!.status).toBe('repaired');
        expect(verdict).toMatchObject({ ok: true, action: 'repaired' });
        expect(service.stats().find((row) => row.kind === 'missingTracker')!.autoActions).toBe(1);
    });

    it('leaves it to M3 when M3 repairs by itself, notifies when M3 is off', async () => {
        env.defects(defect('missingTracker'));
        const service = env.start();
        await env.reply(2);
        expect(service.verdict(2)!.defects[0]!.status).toBe('delegated');
        expect(service.verdict(2)!.ok).toBe(true);

        env.disabledModules.add('medic');
        await service.check(2);
        env.core.autonomy['quality.missingTracker'] = 'auto';
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'edited' });
        env.chat[2]!.mes += ' ';
        await env.reply(2);
        expect(service.verdict(2)!.defects[0]!.status).toBe('notified');
    });
});

describe('notify badges', () => {
    it('«Переделать» swipes with the instruction and counts as an accepted decision', async () => {
        env.defects(defect('userSpeech', { fix: { kind: 'swipe', instruction: 'Leave the user alone.' } }));
        const service = env.start();
        await env.reply(2);
        env.badges[0]!.badge.action!.run();
        await sleep(20);
        expect(env.st.swipes).toHaveLength(1);
        expect(env.metrics.autoSwipes).toBe(0);
        expect(env.autonomy.records).toContainEqual(['quality.userSpeech', 'accepted']);
        expect(env.badges.every((item) => item.removed)).toBe(true);
        expect(service.swipeBudget()).toBe(true);
        await env.generate('swipe');
        expect(env.injections.get('quality_fix')?.text).toBe('[Fix for this reply: Leave the user alone.]');
        await env.end();
    });

    it('«Не брак» dismisses, feeds the false-positive stats and the trust record, and says ok', async () => {
        env.defects(defect('refusal'), defect('repetition'));
        const service = env.start();
        await env.reply(2);
        env.badges[1]!.badge.action!.run();
        await sleep(10);
        const verdict = service.verdict(2)!;
        expect(verdict.defects.every((item) => item.status === 'dismissed')).toBe(true);
        expect(verdict.ok).toBe(true);
        expect(env.bus['reply:ok']).toEqual([{ messageIndex: 2 }]);
        expect(env.autonomy.records).toEqual([
            ['quality.refusal', 'rejected'],
            ['quality.repetition', 'rejected'],
        ]);
        const stats = service.stats();
        expect(stats.find((row) => row.kind === 'refusal')).toMatchObject({ detected: 1, falsePositives: 1 });
        expect(env.badges.every((item) => item.removed)).toBe(true);
    });

    it('dismiss() of one kind keeps the badges for the rest', async () => {
        env.defects(defect('refusal'), defect('repetition'));
        const service = env.start();
        await env.reply(2);
        await service.dismiss(2, 'refusal');
        const open = env.badges.filter((item) => !item.removed);
        expect(open).toHaveLength(2);
        expect(open[0]!.badge.text).toBe('Defect in this reply: repetition');
        expect(service.verdict(2)!.ok).toBe(false);
    });

    it('redo of a reply that is no longer last only explains why', async () => {
        env.defects(defect('refusal'));
        const service = env.start();
        await env.reply(2);
        env.chat.push({ ...env.chat[1]! });
        await service.redo(2);
        expect(env.st.swipes).toHaveLength(0);
        expect(env.notices.at(-1)?.text).toBe('Only the last reply can be redone with a swipe.');
    });
});
