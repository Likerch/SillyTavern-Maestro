// M15 with Dramatis (release 1.17): while Dramatis is present, claims 'voices' and sends its cast block, the voice
// cards do not go out as `maestro_voices` (Dramatis renders them in its block) — also when it decides after Maestro's
// producers ran — and CarrotKernel's insert still leaves the prompt; Dramatis's 'ck.consistency' claim silences CK
// even without cards.
import { afterEach, describe, expect, it } from 'vitest';
import { installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { NORMAL, generate, startVoices, trackerReply, userMessage } from './helpers';
import type { Msg, VoicesTestApp } from './helpers';

const CK = 'OOC MANDATORY: [CHARACTER CONTEXT - CarrotKernel Tags]\n\nAnna: ELF, KUUDERE, STOIC, BLUNT\n';

let app: VoicesTestApp | null = null;
let dramatis: InstalledDramatis | null = null;

afterEach(async () => {
    await app?.stop();
    app = null;
    dramatis?.remove();
    dramatis = null;
});

async function start(
    options: Parameters<typeof startVoices>[0] = {},
): Promise<{ app: VoicesTestApp; dramatis: InstalledDramatis }> {
    app = await startVoices({
        ...options,
        before(test) {
            dramatis = installDramatis(test.env.app);
            options.before?.(test);
        },
    });
    return { app, dramatis: dramatis! };
}

function prompt(): Msg[] {
    return [
        { role: 'system', content: 'Main prompt.' },
        { role: 'assistant', content: 'reply' },
        { role: 'system', content: CK.trim() },
        { role: 'user', content: 'Anna, the map?' },
    ];
}

describe('voice cards merged into Dramatis’s block', () => {
    it('sends no maestro_voices while Dramatis claims them and its block goes out; CK still leaves', async () => {
        const started = await start();
        started.dramatis.adapter.quiet('voices', 'dramatis');
        const messages = await generate(started.app, prompt(), { ck: CK });
        expect(started.app.prompts().maestro_voices?.value ?? '').toBe('');
        expect(messages.map((item) => item.content)).toEqual(['Main prompt.', 'reply', 'Anna, the map?']);
        const quiet = started.app.service.quiet();
        expect(quiet.ck?.outcome).toBe('removed');
        expect(quiet.dramatis).toEqual({ present: true, merged: true, lastMerged: true });
        // The cards themselves are still built: Dramatis reads their speech through MAESTRO_API.speech().
        expect(started.app.api.cards().map((card) => card.name)).toEqual(['Anna', 'Corvin', 'Stranger']);
        expect(started.app.api.ckSilenced()).toBe(true);
    });

    it('sends the cards as usual without the claim, without Dramatis’s block or without Dramatis', async () => {
        const started = await start();
        await generate(started.app, prompt(), { ck: CK });
        expect(started.app.prompts().maestro_voices?.value).toContain('[Voice: Anna]');
        expect(started.app.service.quiet().dramatis).toEqual({ present: true, merged: false, lastMerged: false });

        started.dramatis.adapter.quiet('voices', 'dramatis');
        started.dramatis.api.cast = false;
        await generate(started.app, prompt(), { ck: CK });
        expect(started.app.prompts().maestro_voices?.value).toContain('[Voice: Anna]');

        started.dramatis.api.cast = true;
        started.dramatis.remove();
        await generate(started.app, prompt(), { ck: CK });
        expect(started.app.prompts().maestro_voices?.value).toContain('[Voice: Anna]');
        expect(started.app.service.quiet().dramatis?.present).toBe(false);
    });

    it('takes the cards out of the prompt when Dramatis decided on its block after the producers ran', async () => {
        const started = await start();
        started.dramatis.adapter.quiet('voices', 'dramatis');
        started.dramatis.api.cast = false;
        await started.app.ephemeral.run(NORMAL);
        const cards = started.app.prompts().maestro_voices?.value ?? '';
        expect(cards).toContain('[Voice: Anna]');
        const messages: Msg[] = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'assistant', content: 'reply' },
            { role: 'system', content: cards },
            { role: 'user', content: 'Anna, the map?' },
        ];
        started.dramatis.api.cast = true;
        await started.app.env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, {
            chat: messages,
            dryRun: false,
        });
        expect(messages.map((item) => item.content)).toEqual(['Main prompt.', 'reply', 'Anna, the map?']);
        expect(started.app.service.quiet().dramatis?.lastMerged).toBe(true);
    });
});

describe('CarrotKernel quiet mode claimed by Dramatis', () => {
    const empty = [userMessage('Hi.'), trackerReply([{ name: 'Kai' }]), userMessage('Hm.')];

    it('takes CK’s insert out without cards when Dramatis claims it for a generation with its block', async () => {
        const started = await start({ chat: empty });
        expect(started.app.api.cards()).toEqual([]);
        expect((await generate(started.app, prompt(), { ck: CK })).length).toBe(4);

        started.dramatis.adapter.quiet('ck.consistency', 'dramatis');
        expect((await generate(started.app, prompt(), { ck: CK })).length).toBe(3);
        expect(started.app.service.quiet().ck?.outcome).toBe('removed');

        // Not in quiet generations, dry runs or without the block.
        expect((await generate(started.app, prompt(), { ck: CK, info: { quiet: true, type: 'quiet' } })).length).toBe(
            4,
        );
        expect((await generate(started.app, prompt(), { ck: CK, dryRun: true })).length).toBe(4);
        started.dramatis.api.cast = false;
        expect((await generate(started.app, prompt(), { ck: CK })).length).toBe(4);
    });

    it('keeps the cards and still silences CK when Dramatis claims only CK', async () => {
        const started = await start();
        started.dramatis.adapter.quiet('ck.consistency', 'dramatis');
        const messages = await generate(started.app, prompt(), { ck: CK });
        expect(started.app.prompts().maestro_voices?.value).toContain('[Voice: Anna]');
        expect(messages).toHaveLength(3);
    });
});
