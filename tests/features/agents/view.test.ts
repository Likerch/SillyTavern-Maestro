// @vitest-environment happy-dom
// The «Агенты» window renders every section and the editor's tabs without errors, in Russian.
import { describe, expect, it } from 'vitest';
import { settle } from '../../helpers/core-host';
import { tabsOf, withAgents } from './harness';

describe('agents window', () => {
    it('renders every section; the list shows agents by phase; the editor opens on every tab', async () => {
        const h = await withAgents([
            {
                id: 'u-critic-aaaaa',
                name: 'Критик',
                trigger: { phase: 'post' },
                result: { type: 'note', options: { show: 'strip' } },
            },
            {
                id: 'u-plot-aaaaa',
                name: 'Сюжет',
                trigger: { phase: 'schedule', everyMessages: 10 },
                result: {
                    type: 'memory',
                    options: {
                        fields: [{ name: 'goal' }],
                        inject: true,
                        injectOptions: { position: 'depth', depth: 3, role: 'system', lifetime: 'untilNext' },
                    },
                },
            },
        ]);
        const tabs = tabsOf(h);
        expect(tabs.map((tab) => tab.id)).toEqual([
            'agents',
            'agents-turn',
            'agents-memory',
            'agents-log',
            'agents-templates',
            'agents-sets',
            'agents-cost',
        ]);
        for (const tab of tabs) {
            const container = document.createElement('div');
            const dispose = tab.render(container);
            expect(container.textContent?.length).toBeGreaterThan(10);
            if (typeof dispose === 'function') dispose();
        }
        const list = document.createElement('div');
        tabs[0]!.render(list);
        expect(list.textContent).toContain('Критик');
        expect(list.textContent).toContain('После ответа');
        expect(list.textContent).toContain('По расписанию / событию');
        const edit = [...list.querySelectorAll('button')].find((button) => button.getAttribute('title') === 'Изменить');
        edit?.click();
        await settle(5);
        expect(list.textContent).toContain('Поручение');
        const items = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
        for (const item of items) {
            item.click();
            await settle(2);
        }
        expect(items.length).toBeGreaterThanOrEqual(7);
        const templates = document.createElement('div');
        tabs[4]!.render(templates);
        expect(templates.textContent).toContain('Прозаик');
        expect(templates.textContent).toContain('Именослов');
        const sets = document.createElement('div');
        tabs[5]!.render(sets);
        expect(sets.textContent).toContain('Рассказчик');
        expect(sets.textContent).toContain('Как в 1.27');
    });
});
