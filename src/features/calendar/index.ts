// M17 «Календарь и обещания» (plan M17, M8 routing «Договорённость, срок», M14 п.3; stage 9): agreements and deadlines
// — who promised what to whom, by when in story time — from the revision's deferred cards (and its direct route from
// this stage), placed on a per-chat story clock read from DES. A due promise reaches the director through due(); an
// overdue or broken one is a reason for consequences. Exposed as app.modules.api<CalendarApi>('calendar').
import type { MaestroModule } from '../../shared/contracts';
import type { CalendarApi } from './api';
import { CalendarService } from './service';
import { CALENDAR_ID, CALENDAR_KEY, defaultCalendarSettings, readCalendarSettings } from './settings';
import type { CalendarSettings } from './settings';
import { CALENDAR_STRINGS } from './strings';
import { CALENDAR_CSS, calendarTab } from './view';

export const calendarModule: MaestroModule<CalendarSettings> = {
    id: CALENDAR_ID,
    key: CALENDAR_KEY,
    stage: 9,
    titleKey: 'm17.title',
    enabledByDefault: true,
    defaults: defaultCalendarSettings,
    i18n: CALENDAR_STRINGS,
    init({ app, log, own }) {
        const settings = () => readCalendarSettings(app.settings.module<Partial<CalendarSettings>>(CALENDAR_KEY));
        const service = new CalendarService(app, log.scope('calendar'), settings);
        for (const off of service.install()) own(off);
        app.modules.expose(CALENDAR_KEY, service satisfies Required<CalendarApi>);
        own(app.ui.style('maestro-m17', CALENDAR_CSS));
        own(app.ui.addTab(calendarTab(app, service, settings)));
    },
};

export { CALENDAR_STRINGS } from './strings';
export { CALENDAR_DOC, CALENDAR_ID, CALENDAR_KEY, defaultCalendarSettings, readCalendarSettings } from './settings';
export type { CalendarSettings } from './settings';
export { byDue, CalendarService, clockAt, emptyCalendarDoc, lastCommittedIndex, normaliseCalendarDoc } from './service';
export type { CalendarDoc, ClockEntry, ManualPromise, PromiseOrigin, StoredPromise } from './service';
export { CALENDAR_TAB } from './view';
export type { CalendarApi, PromiseIntake, PromiseStatus, StoryMoment, StoryPromise } from './api';
