// M14 with Dramatis (release 1.17): agendas of Dramatis's characters whose clocks are full or close become twist
// sources, with the weight Dramatis gives them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { twistKey } from '../../../src/domain/director-note';
import { collectTwistSources } from '../../../src/features/director/observe';
import type { App } from '../../../src/shared/contracts';
import { createTestHost } from '../../helpers/core-host';
import { installDramatis, quietLog } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { installStMock } from '../../helpers/st-mock';

let app: App;
let dramatis: InstalledDramatis;

beforeEach(() => {
    const host = createTestHost(installStMock());
    app = {
        host,
        modules: { api: () => undefined },
        adapters: { qvink: { present: () => false } },
    } as unknown as App;
    dramatis = installDramatis(app);
});

afterEach(() => dramatis.remove());

describe('M14 with Dramatis', () => {
    it('takes mature agendas as twist sources with Dramatis’s weights', async () => {
        dramatis.api.agendas = [
            { text: 'The guild calls in Ilva’s debt', weight: 4.5 },
            { text: 'Bram follows the courier to the docks', weight: 2 },
        ];
        const sources = await collectTwistSources(
            app,
            5,
            { characters: [], infoBox: null, quests: { main: 'Escape', optional: [] } },
            quietLog,
        );
        expect(sources.filter((source) => source.kind === 'agenda')).toEqual([
            {
                kind: 'agenda',
                text: 'The guild calls in Ilva’s debt',
                weight: 4.5,
                key: twistKey('agenda', 'The guild calls in Ilva’s debt'),
            },
            {
                kind: 'agenda',
                text: 'Bram follows the courier to the docks',
                weight: 2,
                key: twistKey('agenda', 'Bram follows the courier to the docks'),
            },
        ]);
        expect(sources.some((source) => source.kind === 'quest')).toBe(true);
    });

    it('has none without Dramatis, and survives a broken one', async () => {
        dramatis.api.agendas = [{ text: 'x', weight: 1 }];
        dramatis.api.matureAgendas = () => {
            throw new Error('broken');
        };
        expect(await collectTwistSources(app, 5, null, quietLog)).toEqual([]);
        dramatis.remove();
        expect(await collectTwistSources(app, 5, null, quietLog)).toEqual([]);
    });
});
