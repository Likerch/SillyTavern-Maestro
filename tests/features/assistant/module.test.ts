// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_KEY, assistantModule } from '../../../src/features/assistant';
import type { AssistantApi } from '../../../src/features/assistant';
import type { PultTab, Unsubscribe } from '../../../src/shared/contracts';
import { profileTasks, resetRegistries } from '../../../src/ui/views/registries';
import { answer, createAssistantEnv, readTool } from './env';

describe('M33 module', () => {
    afterEach(() => resetRegistries());

    it('wires the API, the tab, the style, the settings section and the profile row; disable leaves no trace', async () => {
        const env = createAssistantEnv();
        const tabs: PultTab[] = [];
        const styles = new Map<string, string>();
        env.app.ui.addTab = (tab) => {
            tabs.push(tab);
            return () => void tabs.splice(tabs.indexOf(tab), 1);
        };
        env.app.ui.style = (id, css) => {
            styles.set(id, css);
            return () => void styles.delete(id);
        };
        const disposers: Unsubscribe[] = [];
        expect(assistantModule).toMatchObject({ id: 'M33', key: ASSISTANT_KEY, stage: 13, titleKey: 'm33.title' });
        await assistantModule.init({
            app: env.app,
            settings: env.settings.module(ASSISTANT_KEY),
            log: env.log,
            own: (dispose) => void disposers.push(dispose as Unsubscribe),
        });
        const api = env.modules.apis.get(ASSISTANT_KEY) as AssistantApi;
        expect(typeof api.send).toBe('function');
        expect(tabs.map((tab) => [tab.id, tab.group, tab.order, tab.icon])).toEqual([
            ['assistant', 'assistant', 95, 'fa-comments'],
        ]);
        expect(styles.has('maestro-m33')).toBe(true);
        expect(env.ui.sections.map((section) => section.id)).toEqual([ASSISTANT_KEY]);
        expect(profileTasks()).toEqual([{ id: 'assistant', labelKey: 'm33.profileTask' }]);
        expect(env.journal.handlers.has('assistant.setting')).toBe(true);
        // The built-in tools are registered (whatever part of them this fake app offers).
        expect(Array.isArray(api.tools())).toBe(true);

        const off = api.registerTool(readTool('extra_tool', async () => ({ data: 1 })));
        expect(api.tools().some((tool) => tool.name === 'extra_tool')).toBe(true);
        off();
        expect(api.tools().some((tool) => tool.name === 'extra_tool')).toBe(false);

        env.llm.script(answer('Hi'));
        await api.send('hello');
        expect(api.conversation().map((message) => message.role)).toEqual(['user', 'assistant']);

        for (const dispose of disposers.reverse()) await dispose();
        expect(tabs).toEqual([]);
        expect(styles.size).toBe(0);
        expect(env.ui.sections).toEqual([]);
        expect(profileTasks()).toEqual([]);
    });
});
