// M35 «Режим BunnyMo» (stage 3; plan M35 п. 4–9, P13, Q25; dev-plan 3.5): the tag dictionary of the loaded packs,
// the pack manager with packs per chat (suppressed on the fly), «compare with a file», the archive (sheet) editor, the
// integrity checks and the list of runtime fixes to BunnyMo books. Pack files are never written.
// Exposed as app.modules.api<BunnyMoModeApi>('bunnymoMode'); pult tab 'bunnymo'; command /maestro-bunnymo.
import { formatEnum } from '../../core/labels';
import type { MaestroModule } from '../../shared/contracts';
import type { BunnyMoModeApi } from './api';
import { BUNNYMO_MODE_ID, BUNNYMO_MODE_KEY, BunnyMoModeService, SELECTION_TARGET, SHEET_TARGET } from './service';
import { BUNNYMO_MODE_STRINGS } from './strings';
import { BUNNYMO_MODE_CSS } from './styles';
import { bunnymoTab } from './view';
import { initialViewState } from './view-common';

export type BunnyMoModeSettings = Record<string, never>;

/** How many findings the health check names. */
const HEALTH_SAMPLE = 1;
/** `SPECIES:ELF` typed without brackets, or a bare MBTI archetype (`ENTJ-U`). */
const TAG_LIKE_RE = /^(?:[A-Za-z][A-Za-z0-9_-]*:[^<>:\n]+|[EI][NS][FT][JP]-[UH])$/i;

export const bunnymoModeModule: MaestroModule<BunnyMoModeSettings> = {
    id: BUNNYMO_MODE_ID,
    key: BUNNYMO_MODE_KEY,
    stage: 3,
    titleKey: 'm35b.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: BUNNYMO_MODE_STRINGS,
    targets: [
        {
            target: SELECTION_TARGET,
            fields: {
                mode: { labelKey: 'm35b.target.mode', format: formatEnum('m35b.target.mode.') },
                books: { labelKey: 'm35b.target.books' },
            },
        },
        // A sheet is CarrotKernel markup (<Name:…>, <BunnymoTags>): the whole value stays under «Подробнее».
        { target: SHEET_TARGET, technical: true },
    ],
    init({ app, log, own }) {
        const service = new BunnyMoModeService(app, log);
        for (const off of service.install()) own(off);
        app.modules.expose(BUNNYMO_MODE_KEY, service.api() satisfies BunnyMoModeApi);

        const state = initialViewState();
        own(app.ui.style('m35b-view', BUNNYMO_MODE_CSS));
        own(app.ui.addTab(bunnymoTab(app, service, state)));
        own(
            app.ui.addHealthCheck({
                id: 'm35b.integrity',
                module: BUNNYMO_MODE_ID,
                titleKey: 'm35b.health.title',
                async run() {
                    const findings = await service.integrity();
                    if (!findings.length) return { status: 'ok', message: app.i18n.t('m35b.health.ok') };
                    return {
                        status: 'warn',
                        message: app.i18n.t('m35b.health.found', {
                            count: findings.length,
                            first: findings
                                .slice(0, HEALTH_SAMPLE)
                                .map((finding) => finding.text)
                                .join(' '),
                        }),
                    };
                },
            }),
        );
        own(
            app.ui.addSlashCommand({
                name: 'maestro-bunnymo',
                helpKey: 'm35b.slash.help',
                args: [{ name: 'value', descriptionKey: 'm35b.slash.value', optional: true }],
                callback: async (_args, value) => {
                    const text = value.trim();
                    if (!text) {
                        service.open();
                        return '';
                    }
                    // A tag opens the dictionary; a character name its sheet; a book its pack or archive list.
                    if (text.startsWith('<') || TAG_LIKE_RE.test(text)) {
                        service.open({ tag: text.startsWith('<') ? text : `<${text}>` });
                        return '';
                    }
                    const archive = await service.findArchive(text);
                    if (archive) {
                        service.open(archive);
                        return '';
                    }
                    if (service.worldNames().includes(text)) {
                        service.open({ book: text });
                        return '';
                    }
                    service.open({ tag: text });
                    return '';
                },
            }),
        );
    },
};

export { BUNNYMO_MODE_STRINGS } from './strings';
export { BunnyMoModeService, BUNNYMO_MODE_ID, BUNNYMO_MODE_KEY, SELECTION_TARGET, SHEET_TARGET } from './service';
export type {
    ArchiveSheet,
    BunnyMoModeApi,
    IntegrityFinding,
    PackDiff,
    PackInfo,
    PackSelection,
    TagDictionary,
    TagInfo,
    TagValidation,
} from './api';
