// Maestro's bus: handlers in registration order, one failure does not stop the others, and a handler removed by an
// earlier one of the same emit (its module paused by «Мастерская») is not called.
import { describe, expect, it } from 'vitest';
import { createBus } from '../../src/core/bus';
import { createTestLogger } from '../helpers/core-host';

describe('EventBus', () => {
    it('runs handlers in order and isolates failures', async () => {
        const bus = createBus(createTestLogger());
        const seen: string[] = [];
        bus.on('chat:changed', () => {
            seen.push('a');
            throw new Error('boom');
        });
        bus.on('chat:changed', ({ chatId }) => {
            seen.push(`b ${chatId}`);
        });
        await bus.emit('chat:changed', { chatId: 'c1' });
        expect(seen).toEqual(['a', 'b c1']);
    });

    it('skips a handler removed during the emit', async () => {
        const bus = createBus(createTestLogger());
        const seen: string[] = [];
        let off: () => void = () => {};
        bus.on('workshop:changed', () => {
            seen.push('first');
            off();
        });
        off = bus.on('workshop:changed', () => {
            seen.push('second');
        });
        await bus.emit('workshop:changed', { active: true, chatId: 'c' });
        expect(seen).toEqual(['first']);
    });
});
