// M9 «Летопись, автопамять и „Ранее в истории…"» (plan M9, §5 phase 0, §8; dev-plan 4.5):
// - chapters: Qvink memories that fell out of the long-term budget become canon chapters with AND keys (M6 budget);
// - merging: small neighbouring chapters about the same thing become one;
// - auto-memory: Maestro is the only owner of Qvink's «remember» mark (all swipes);
// - «Ранее в истории…» after a break, once per break.
// Exposed as app.modules.api<ChronicleApi>('chronicle').
import { registerBuiltInAgent } from '../../core/builtin-agents';
import { RECAP_INSTRUCTION_HEAD } from '../../domain/chronicle-recap';
import type { MaestroModule, Unsubscribe } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { ChronicleApi } from './api';
import { ChapterService } from './chapters';
import { COVER_TARGET, ChapterCovers } from './covers';
import { createChronicleEnv } from './env';
import { AutoMemory } from './memory';
import { RECAP_CSS, RECAP_TASK, RecapService } from './recap';
import { CHRONICLE_ID, CHRONICLE_KEY, defaultChronicleSettings, readChronicleSettings } from './settings';
import type { ChronicleSettings } from './settings';
import { ChronicleStore } from './store';
import { CHRONICLE_STRINGS, CHRONICLE_TARGETS } from './strings';
import { CHRONICLE_CSS, chronicleTab } from './view';

export const chronicleModule: MaestroModule<ChronicleSettings> = {
    id: CHRONICLE_ID,
    key: CHRONICLE_KEY,
    stage: 4,
    titleKey: 'm9.title',
    enabledByDefault: true,
    defaults: defaultChronicleSettings,
    i18n: CHRONICLE_STRINGS,
    targets: CHRONICLE_TARGETS,
    init({ app, settings, log, own }) {
        const read = () => readChronicleSettings(settings);
        read();
        const store = new ChronicleStore(app, log);
        for (const off of store.install()) own(off);
        const env = createChronicleEnv(app, log, store, read);
        const chapters = new ChapterService(env);
        for (const off of chapters.install()) own(off);
        const memory = new AutoMemory(env);
        for (const off of memory.install()) own(off);
        const recap = new RecapService(env, chapters);
        for (const off of recap.install()) own(off);

        const covers = new ChapterCovers(app, log.scope('covers'), {
            chapters: () => chapters.chapters(),
            chapterText: (uid) => chapters.chapterText(uid),
        });
        own(covers.installReceiver());
        own(app.bus.on('chat:changed', () => covers.chatChanged()));
        app.journal.registerUndo(COVER_TARGET, (change) => covers.undo(change));

        const onChange = (listener: () => void): Unsubscribe => {
            const offs = [store.onChange(listener), chapters.onChange(listener), covers.onChange(listener)];
            return () => offs.forEach((off) => off());
        };
        const api: ChronicleApi = {
            chapters: () => chapters.chapters(),
            remembered: () => memory.remembered(),
            recapNow: () => recap.recapNow(),
            onChange,
            covers: () => covers.all(),
            uncoveredText: (budget) => covers.agentText(budget),
        };
        app.modules.expose(CHRONICLE_KEY, api);
        own(() => app.modules.expose(CHRONICLE_KEY, undefined));

        own(registerProfileTask(RECAP_TASK, 'm9.profileTask'));
        own(
            registerBuiltInAgent({
                id: RECAP_TASK,
                module: 'chronicle',
                group: 'story',
                icon: 'fa-clock-rotate-left',
                defaultInstructions: () => [RECAP_INSTRUCTION_HEAD],
                defaults: { maxTokens: 400, temperature: 0.4 },
                knobs: [
                    {
                        path: 'recap.source',
                        labelKey: 'm44.bi.chronicle.recap.knob.recap.source',
                        kind: 'select',
                        options: [
                            { value: 'memory', labelKey: 'm44.bi.chronicle.recap.knob.recap.source.memory' },
                            { value: 'ai', labelKey: 'm44.bi.chronicle.recap.knob.recap.source.ai' },
                        ],
                    },
                    {
                        path: 'recap.afterHours',
                        labelKey: 'm44.bi.chronicle.recap.knob.recap.afterHours',
                        kind: 'number',
                        min: 1,
                        max: 720,
                        step: 1,
                    },
                    {
                        path: 'recap.target',
                        labelKey: 'm44.bi.chronicle.recap.knob.recap.target',
                        kind: 'select',
                        options: [
                            { value: 'user', labelKey: 'm44.bi.chronicle.recap.knob.recap.target.user' },
                            {
                                value: 'userAndPrompt',
                                labelKey: 'm44.bi.chronicle.recap.knob.recap.target.userAndPrompt',
                            },
                            { value: 'off', labelKey: 'm44.bi.chronicle.recap.knob.recap.target.off' },
                        ],
                    },
                ],
            }),
        );
        own(app.ui.style('m9-chronicle', `${CHRONICLE_CSS}\n${RECAP_CSS}`));
        own(app.ui.addTab(chronicleTab({ env, chapters, memory, recap, covers, onChange })));

        void store.load();
        chapters.start();
        recap.start();
    },
};

export { CHRONICLE_STRINGS, CHRONICLE_TARGETS } from './strings';
export { CHRONICLE_ID, CHRONICLE_KEY, defaultChronicleSettings } from './settings';
export type { ChronicleSettings } from './settings';
export type { Chapter, ChronicleApi, RecapSettings } from './api';
