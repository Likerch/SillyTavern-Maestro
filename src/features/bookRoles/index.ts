// M35 «Роли книг» (stage 2 part of M35; plan M35 п. 1–2, P2, P13): what each lorebook is (BunnyMo core and packs,
// CK archives, world, card, NPC, canon, Maestro, chat, persona, backups), kept in a Maestro registry with the user's
// overrides, and the entry-meta sidecar for base books. Exposed as app.modules.api<BookRolesApi>('bookRoles').
import { formatEnum } from '../../core/labels';
import type { MaestroModule } from '../../shared/contracts';
import { BOOK_ROLES_ID, BOOK_ROLES_KEY, BookRolesService, ROLE_TARGET } from './service';
import { BOOK_ROLES_STRINGS } from './strings';

export type BookRolesSettings = Record<string, never>;

export const bookRolesModule: MaestroModule<BookRolesSettings> = {
    id: BOOK_ROLES_ID,
    key: BOOK_ROLES_KEY,
    stage: 2,
    titleKey: 'm35r.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: BOOK_ROLES_STRINGS,
    targets: [
        {
            target: ROLE_TARGET,
            fields: {
                role: { labelKey: 'm35r.field.role', format: formatEnum('m35r.role.') },
                source: { labelKey: 'm35r.field.source', format: formatEnum('m35r.source.') },
            },
        },
    ],
    init({ app, log, own }) {
        const service = new BookRolesService(app, log);
        for (const off of service.install()) own(off);
        own(() => service.dispose());
        app.modules.expose(BOOK_ROLES_KEY, service.api());
        service.start();
    },
};

export { BOOK_ROLES_STRINGS } from './strings';
export { BookRolesService, ENTRY_META_FILE, ROLES_FILE } from './service';
export type { BookRole, BookRoleInfo, BookRolesApi } from './api';
