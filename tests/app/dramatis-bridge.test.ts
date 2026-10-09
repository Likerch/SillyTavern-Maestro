// Release 1.17, Maestro's Dramatis bridge while the voice cards (M15) are off: CarrotKernel's «Character Consistency»
// insert leaves the prompt of a real generation in which Dramatis — present, claiming 'ck.consistency' — sends its cast
// block, and DES-RU stops rebuilding it meanwhile. With M15 running the bridge stays out of the way.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDramatisBridge } from '../../src/app/dramatis-bridge';
import type { DramatisBridge } from '../../src/app/dramatis-bridge';
import { CK_FUNCTION } from '../../src/features/voices/ck-quiet';
import type { GenerationInfo } from '../../src/shared/contracts';
import { installDramatis } from '../helpers/dramatis';
import type { InstalledDramatis } from '../helpers/dramatis';
import { createRulesTestApp } from '../helpers/rules-app';
import type { RulesTestApp } from '../helpers/rules-app';
import { EVENT_TYPES } from '../helpers/st-mock';
import { FakeDesRuApi, fakeDesRuAdapter } from '../features/voices/helpers';

const CK = 'OOC MANDATORY: [CHARACTER CONTEXT - CarrotKernel Tags]\n\nAnna: ELF, KUUDERE\n';

let env: RulesTestApp;
let dramatis: InstalledDramatis;
let bridge: DramatisBridge;
let desru: FakeDesRuApi;
let generation: GenerationInfo | null;

function prompt(): { role: string; content: string }[] {
    return [
        { role: 'system', content: 'Main.' },
        { role: 'system', content: CK.trim() },
        { role: 'user', content: 'Hi' },
    ];
}

async function ready(messages: { role: string; content: string }[], dryRun = false) {
    await env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, { chat: messages, dryRun });
    return messages;
}

beforeEach(() => {
    env = createRulesTestApp({ firstRunDone: true });
    (env.mock.context as unknown as Record<string, unknown>).extensionPrompts = {
        'script_inject_carrot-consistency': { value: CK, position: 1, depth: 4, role: 0 },
    };
    generation = { type: 'normal', dryRun: false, quiet: false };
    env.turn.current = () => generation;
    desru = new FakeDesRuApi();
    (env.app.adapters as unknown as Record<string, unknown>).desru = fakeDesRuAdapter({ api: desru });
    dramatis = installDramatis(env.app);
    bridge = installDramatisBridge(env.app);
});

afterEach(() => {
    bridge.dispose();
    dramatis.remove();
});

describe('Dramatis bridge (voice cards off)', () => {
    it('leaves CK alone until Dramatis claims it', async () => {
        expect(await ready(prompt())).toHaveLength(3);
        expect(bridge.last()).toBeNull();
        expect(desru.maestroOwned()).toEqual([]);
    });

    it('takes CK’s insert out of a real generation with Dramatis’s block and tells DES-RU', async () => {
        const off = dramatis.adapter.quiet('ck.consistency', 'dramatis');
        expect(desru.maestroOwned()).toEqual([CK_FUNCTION]);
        const messages = await ready(prompt());
        expect(messages.map((item) => item.content)).toEqual(['Main.', 'Hi']);
        expect(bridge.last()?.outcome).toBe('removed');

        // Not without the block, in dry runs, quiet requests of other extensions or sheet commands.
        dramatis.api.cast = false;
        expect(await ready(prompt())).toHaveLength(3);
        dramatis.api.cast = true;
        expect(await ready(prompt(), true)).toHaveLength(3);
        generation = null;
        expect(await ready(prompt())).toHaveLength(3);
        generation = { type: 'normal', dryRun: false, quiet: false, sheetCommand: '!fullsheet' };
        expect(await ready(prompt())).toHaveLength(3);
        generation = { type: 'normal', dryRun: false, quiet: false };

        off();
        expect(desru.maestroOwned()).toEqual([]);
        expect(await ready(prompt())).toHaveLength(3);
    });

    it('stays out of the way while the voice cards run, and gives DES-RU back when it stops', async () => {
        dramatis.adapter.quiet('ck.consistency', 'dramatis');
        env.modules.apis.set('voices', {});
        expect(await ready(prompt())).toHaveLength(3);
        env.modules.apis.delete('voices');
        expect(await ready(prompt())).toHaveLength(2);
        expect(desru.maestroOwned()).toEqual([CK_FUNCTION]);
        bridge.dispose();
        expect(desru.maestroOwned()).toEqual([]);
        expect(await ready(prompt())).toHaveLength(3);
    });

    it('does nothing when Dramatis is gone', async () => {
        dramatis.adapter.quiet('ck.consistency', 'dramatis');
        dramatis.remove();
        expect(await ready(prompt())).toHaveLength(3);
    });
});
