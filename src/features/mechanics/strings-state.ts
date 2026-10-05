// Strings of M25 «Механики», the state and tracking part (`m25.state.*`, `m25.track.*`, `kind.mechanics.*`). Russian
// is the primary UI language; the user is addressed as «ты» (male).
import type { I18nParts } from '../../shared/contracts';

export const STATE_STRINGS: I18nParts = {
    en: {
        'm25.state.holder.world': 'World',
        'm25.state.source.desStats': 'DES stats',
        'm25.state.source.block': 'service block',
        'm25.state.source.background': 'background parse',
        'm25.state.source.check': 'check',
        'm25.state.source.event': 'event',
        'm25.state.source.user': 'by hand',
        'm25.state.journal.set': 'Mechanics: {holder} · {attribute} = {value}',
        'm25.state.journal.setMany': 'Mechanics: {count} values changed by hand',
        'm25.state.error.noChat': 'No chat is open.',
        'm25.state.error.rejected': 'The value was not changed: {reason}.',
        'm25.state.reject.mechanic': 'this mechanic is not in this chat',
        'm25.state.reject.attribute': 'the mechanic has no such attribute',
        'm25.state.reject.holder': 'this holder does not take part in the mechanic',
        'm25.state.reject.leader': 'another Maestro tab follows this chat',
        'm25.state.reject.value': 'the value does not fit the attribute',

        'm25.track.block.dropped': 'Mechanics: the service block of reply #{index} could not be read; it was removed.',
        'm25.track.block.partial':
            'Mechanics: lines of the service block in reply #{index} that could not be read: {count}.',
        'm25.track.change.title': 'Mechanics: changes from reply #{index} ({count})',
        'm25.track.desStats.title': 'Add the stats of «{name}» to DES',
        'm25.track.desStats.description':
            'DES will ask the model for these stats of every character in the scene: {list}. Your own DES stats stay as they are; the character stats of DES are switched on.',
        'm25.track.desStats.noDes': 'DES is not available: the stats cannot be added.',
        'm25.track.desStats.workshop': 'The DES Workshop is open: close it and try again.',

        'kind.mechanics.change': 'Mechanics: values from the background parse',
        'kind.mechanics.desStats': 'Mechanics: stats in DES',
        'kind.mechanics.set': 'Mechanics: a value changed by hand',
    },
    ru: {
        'm25.state.holder.world': 'Мир',
        'm25.state.source.desStats': 'статы DES',
        'm25.state.source.block': 'служебный блок',
        'm25.state.source.background': 'фоновый разбор',
        'm25.state.source.check': 'проверка',
        'm25.state.source.event': 'событие',
        'm25.state.source.user': 'вручную',
        'm25.state.journal.set': 'Механики: {holder} · {attribute} = {value}',
        'm25.state.journal.setMany': 'Механики: значений изменено вручную — {count}',
        'm25.state.error.noChat': 'Чат не открыт.',
        'm25.state.error.rejected': 'Значение не изменено: {reason}.',
        'm25.state.reject.mechanic': 'этой механики нет в чате',
        'm25.state.reject.attribute': 'у механики нет такого атрибута',
        'm25.state.reject.holder': 'у этого участника нет такой механики',
        'm25.state.reject.leader': 'этот чат ведёт другая вкладка Maestro',
        'm25.state.reject.value': 'значение не подходит атрибуту',

        'm25.track.block.dropped': 'Механики: служебный блок в ответе №{index} не удалось прочитать — он убран.',
        'm25.track.block.partial': 'Механики: в служебном блоке ответа №{index} не прочитано строк: {count}.',
        'm25.track.change.title': 'Механики: изменения из ответа №{index} ({count})',
        'm25.track.desStats.title': 'Добавить статы механики «{name}» в DES',
        'm25.track.desStats.description':
            'DES будет просить у модели эти статы для каждого персонажа в сцене: {list}. Твои собственные статы DES останутся как есть; статы персонажей в DES включатся.',
        'm25.track.desStats.noDes': 'DES недоступен: статы добавить нельзя.',
        'm25.track.desStats.workshop': 'Открыта Мастерская DES: закрой её и попробуй ещё раз.',

        'kind.mechanics.change': 'Механики: значения из фонового разбора',
        'kind.mechanics.desStats': 'Механики: статы в DES',
        'kind.mechanics.set': 'Механики: значение изменено вручную',
    },
};
