// M38 «Проверка промпта»: how instructions, conflicts and fixes read to the user (plan-2 §3 style): owners in plain
// words («Пресет «Marinara», блок «Task»», «Трекер DES: инструкции»), titles and explanations from the rule hits,
// advice for what Maestro does not change itself. Slot keys, ids and refs stay in «Подробнее».
import type { AdviceReason } from '../../domain/prompt-audit-fix';
import type { AuditCapture, AuditItem } from '../../domain/prompt-audit-map';
import type { AuditFix, RuleHit } from '../../domain/prompt-audit-rules';
import type { App } from '../../shared/contracts';

type T = (key: string, params?: Record<string, string | number>) => string;

function translator(app: App): T {
    return (key, params) => app.i18n.t(key, params);
}

/** A translation, or undefined when the key has none (another module's strings may be missing). */
function maybe(app: App, key: string, params?: Record<string, string | number>): string | undefined {
    const text = app.i18n.t(key, params);
    return text === key ? undefined : text;
}

/** Slots of DES with a name of their own. */
const DES_SLOTS: readonly [RegExp, string][] = [
    [/^dooms[-_]tracker[-_]inject/i, 'm38.owner.desTracker'],
    [/^dooms[-_]tracker[-_]html/i, 'm38.owner.desHtml'],
    [/^dooms[-_]tracker[-_]dialogue/i, 'm38.owner.desColors'],
    [/^dooms[-_]tracker[-_]context/i, 'm38.owner.desContext'],
];

function moduleTitle(app: App, key: string | undefined): string {
    if (!key) return '';
    const module = app.modules.list().find((entry) => entry.module.key === key)?.module;
    return module ? app.i18n.t(module.titleKey) : key;
}

/** A part of Dramatis (its slot `dramatis_<part>`) in words; unknown parts as they are. */
function dramatisPart(app: App, part: string | undefined): string {
    if (!part) return '';
    return maybe(app, `m38.dramatis.${part}`) ?? part;
}

/** Who an instruction belongs to, in plain words. */
export function ownerLabel(app: App, item: AuditItem | undefined, preset?: string): string {
    const t = translator(app);
    if (!item) return t('m38.owner.gone');
    switch (item.owner) {
        case 'preset':
            return t('m38.owner.preset', { preset: preset ?? '', block: item.label });
        case 'card':
            return t(`m38.owner.card.${item.key === 'system' || item.key === 'postHistory' ? item.key : 'depth'}`);
        case 'authorsNote':
            return t('m38.owner.authorsNote');
        case 'maestro':
            return t('m38.owner.maestro', { module: moduleTitle(app, item.module) });
        case 'dramatis':
            return t('m38.owner.dramatis', { part: dramatisPart(app, item.module) });
        case 'bunnymo':
            return t('m38.owner.bunnymo', { entry: item.label });
        case 'lore':
            return t('m38.owner.lore', { book: item.book ?? '', entry: item.label });
        case 'other':
            return t('m38.owner.other');
        default: {
            if (item.owner === 'des') {
                const key = DES_SLOTS.find(([pattern]) => pattern.test(item.key ?? ''))?.[1];
                if (key) return t(key);
            }
            const id = item.neighbours?.[0];
            const named = id ? maybe(app, `m36.p.${id}.label`) : undefined;
            return named ?? t(`m38.owner.${item.owner}`);
        }
    }
}

/** The owner of a ref in a capture. */
export function refLabel(app: App, capture: AuditCapture | null, ref: string): string {
    const item = capture?.items.find((entry) => entry.ref === ref);
    return ownerLabel(app, item, capture?.preset);
}

/* ------------------------------------------------------------------ values */

const UNIT_KEYS: Record<string, string> = {
    words: 'm38.unit.words',
    paragraphs: 'm38.unit.paragraphs',
    sentences: 'm38.unit.sentences',
    tokens: 'm38.unit.tokens',
    lines: 'm38.unit.lines',
};

/** A value code of a rule hit in words: 'ru' → «русский», '!third' → «не от третьего лица», '≤150 words'. */
export function valueText(app: App, topic: RuleHit['topic'], value: string | undefined): string {
    const t = translator(app);
    if (!value) return '';
    const negated = value.startsWith('!');
    const code = negated ? value.slice(1) : value;
    let text: string;
    switch (topic) {
        case 'language':
            text = maybe(app, `m38.lang.${code}`) ?? code;
            break;
        case 'pov':
        case 'tense':
        case 'format':
            text = maybe(app, `m38.value.${code}`) ?? code;
            break;
        case 'length':
        case 'tight':
            text = code.replace(/(words|paragraphs|sentences|tokens|lines)$/, (unit) => t(UNIT_KEYS[unit]!));
            break;
        default:
            text = code;
    }
    return negated ? t('m38.value.not', { value: text }) : text;
}

/* ------------------------------------------------------------------ conflicts */

export function topicTitle(app: App, hit: Pick<RuleHit, 'topic'>): string {
    return app.i18n.t(`m38.topic.${hit.topic}`);
}

function demandList(app: App, demands: readonly string[] | undefined): string {
    const names = (demands ?? []).map((demand) => app.i18n.t(`m38.demand.${demand}`));
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} ${app.i18n.t('m38.and')} ${names[names.length - 1]}`;
}

/** Why a rule hit matters, in plain words. */
export function whyText(app: App, hit: RuleHit, capture: AuditCapture | null): string {
    const t = translator(app);
    const a = valueText(app, hit.topic, hit.values?.a);
    const b = valueText(app, hit.topic, hit.values?.b);
    switch (hit.topic) {
        case 'tight':
            return t('m38.why.tight', { limit: a, demands: demandList(app, hit.demands) });
        case 'role': {
            const owners = new Set(
                [hit.a, hit.b, ...(hit.also ?? [])]
                    .filter((side) => !!side)
                    .map((side) => capture?.items.find((entry) => entry.ref === side!.ref)?.owner),
            );
            const tracker = /^slot:dooms[-_]tracker[-_]inject/i.test(hit.a.ref);
            if (hit.values?.a === 'trailing' && (tracker || owners.size >= 2)) {
                return t('m38.why.roleTrailing', { chars: hit.values?.b ?? '' });
            }
            return t(hit.values?.a === 'trailing' ? 'm38.why.roleEnd' : 'm38.why.roleMiddle');
        }
        case 'format':
            return t(hit.values?.a === 'plain' || hit.values?.b === 'plain' ? 'm38.why.plain' : 'm38.why.format', {
                value: valueText(app, 'format', (hit.demands ?? [])[0] ?? hit.values?.a?.replace('!', '')),
            });
        default:
            return t(`m38.why.${hit.topic}`, { a, b });
    }
}

/** What the conflict does on the active model (role risks always; other topics: nothing model-specific). */
export function riskText(app: App, hit: RuleHit, capture: AuditCapture | null): string | undefined {
    if (!hit.quirk) return undefined;
    const model = capture?.connection?.model || app.i18n.t('m38.model.this');
    return app.i18n.t(`m38.risk.${hit.quirk}`, { model });
}

/* ------------------------------------------------------------------ fixes */

/** A fix described as a change («замени «…» на «…»», «выключи», «поставь роль …»). */
export function changeText(app: App, fix: AuditFix): string {
    const t = translator(app);
    switch (fix.kind) {
        case 'edit':
            return t('m38.change.edit', { before: fix.before ?? '', after: fix.after ?? '' });
        case 'remove':
            return t('m38.change.remove', { before: fix.before ?? '' });
        case 'toggle':
            return t('m38.change.toggle');
        case 'role':
            return t('m38.change.role', { role: t(`m38.role.${fix.role ?? 'user'}`) });
        case 'move':
            return t('m38.change.move', { depth: fix.depth ?? 0 });
        default:
            return '';
    }
}

/** Why the proposed side (rules' reason codes; the AI's fixes carry no code). */
export function reasonText(app: App, fix: AuditFix, target: string, other: string): string | undefined {
    if (!fix.reason) return undefined;
    return maybe(app, `m38.reason.${fix.reason}`, { target, other });
}

/** What to do by hand when Maestro does not change the owner's text itself. */
export function adviceText(
    app: App,
    reason: AdviceReason,
    fix: AuditFix,
    item: AuditItem | undefined,
    params: { target: string; risk?: string },
): string {
    const t = translator(app);
    const change = changeText(app, fix);
    if (reason === 'neighbourSetting' && fix.kind === 'role' && /^dooms[-_]tracker[-_]inject/i.test(item?.key ?? '')) {
        return t('m38.advice.desRole', { role: t(`m38.role.${fix.role ?? 'user'}`) });
    }
    return t(`m38.advice.${reason}`, {
        target: params.target,
        change,
        module: reason === 'dramatis' ? dramatisPart(app, item?.module) : moduleTitle(app, item?.module),
        book: item?.book ?? '',
        risk: params.risk ?? '',
    });
}
