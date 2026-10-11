// @vitest-environment happy-dom
// rerenderMessage (src/host/messages.ts): Maestro re-renders a message it changed the way ST's message editor does,
// with MESSAGE_UPDATED after the new HTML, so DES lays the reply out as speaker cards again (1.21.1). Without the
// event DES kept its "bubbles applied" mark on .mes_text and the reply stayed plain until the editor was opened.
import { beforeEach, describe, expect, it } from 'vitest';
import { createHost } from '../../src/host';
import { rerenderMessage } from '../../src/host/messages';
import { installStMock, message } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { memoryLogger } from '../helpers/host-fakes';

let mock: StMock;
let calls: string[];

beforeEach(() => {
    mock = installStMock();
    mock.chat.push(message('Old.'), message('New.'));
    calls = [];
    (mock.context as unknown as Record<string, unknown>).updateMessageBlock = (index: number) => {
        calls.push(`render:${index}`);
    };
    for (const event of ['message_updated', 'message_edited']) {
        mock.eventSource.on(event, (index) => {
            calls.push(`${event}:${String(index)}`);
        });
    }
    document.body.innerHTML = '<div id="chat"><div class="mes" mesid="1"><div class="mes_text"></div></div></div>';
});

describe('rerenderMessage', () => {
    it('re-renders, then emits MESSAGE_UPDATED for a message on screen (never MESSAGE_EDITED)', async () => {
        await rerenderMessage(createHost(memoryLogger()), 1, mock.chat[1]!);
        expect(calls).toEqual(['render:1', 'message_updated:1']);
    });

    it('re-renders synchronously, before the first await', () => {
        void rerenderMessage(createHost(memoryLogger()), 1, mock.chat[1]!, { announce: false });
        expect(calls).toEqual(['render:1']);
    });

    it('stays quiet for a message that is not on screen or when told not to announce', async () => {
        const host = createHost(memoryLogger());
        await rerenderMessage(host, 0, mock.chat[0]!);
        await rerenderMessage(host, 1, mock.chat[1]!, { announce: false });
        expect(calls).toEqual(['render:0', 'render:1']);
    });

    it('leaves a message whose editor is open alone, so the typed text survives (1.21.2)', async () => {
        const host = createHost(memoryLogger());
        document.querySelector('#chat .mes[mesid="1"] .mes_text')!.innerHTML =
            '<textarea id="curEditTextarea" class="edit_textarea">typing…</textarea>';
        await rerenderMessage(host, 1, mock.chat[1]!);
        expect(calls).toEqual([]);
        expect(document.querySelector<HTMLTextAreaElement>('#curEditTextarea')?.value).toBe('typing…');
        document.querySelector('#chat .mes[mesid="1"]')!.innerHTML =
            '<div class="mes_text"></div><textarea class="reasoning_edit_textarea"></textarea>';
        await rerenderMessage(host, 1, mock.chat[1]!);
        expect(calls).toEqual([]);
    });

    it('does nothing without updateMessageBlock and logs a failing one without announcing', async () => {
        const log = memoryLogger();
        const host = createHost(log);
        (mock.context as unknown as Record<string, unknown>).updateMessageBlock = undefined;
        await rerenderMessage(host, 1, mock.chat[1]!, { log });
        (mock.context as unknown as Record<string, unknown>).updateMessageBlock = () => {
            throw new Error('boom');
        };
        await rerenderMessage(host, 1, mock.chat[1]!, { log });
        expect(calls).toEqual([]);
        expect(log.lines.map((line) => line.level)).toEqual(['warn']);
    });
});
