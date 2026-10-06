// Strings of M25 «Механики», the state and tracking part (`m25.state.*`, `m25.track.*`, `kind.mechanics.*` and the
// journal targets `target.mechanics.*`). Russian is the primary UI language; the user is addressed as «ты» (male).
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
        'm25.state.journal.set': '{holder}: {attribute} is now {value} (changed by hand)',
        'm25.state.journal.setMany': 'Mechanics values changed by hand: {count}',
        'm25.state.error.noChat': 'No chat is open.',
        'm25.state.error.rejected': 'The value was not changed: {reason}.',
        'm25.state.reject.mechanic': 'this mechanic is not in this chat',
        'm25.state.reject.attribute': 'the mechanic has no such attribute',
        'm25.state.reject.holder': 'this holder does not take part in the mechanic',
        'm25.state.reject.leader': 'another Maestro tab follows this chat',
        'm25.state.reject.value': 'the value does not fit the attribute',

        'm25.track.block.dropped':
            'I could not read the mechanics changes in reply #{index}, so I removed that service block from the reply.',
        'm25.track.block.partial':
            'Some mechanics changes in reply #{index} could not be read, so I skipped them (lines: {count}).',
        'm25.track.change.title': 'Mechanics changes in reply #{index}: {count}',
        'm25.track.change.done': 'Updated the mechanics from reply #{index}.',
        'm25.track.desStats.title': 'Add the stats of «{name}» to the DES tracker?',
        'm25.track.desStats.description':
            'DES will ask the model for these stats of every character in the scene: {list}. Your own DES stats stay as they are; the character stats of DES are switched on.',
        'm25.track.desStats.noDes': 'DES is not available: the stats cannot be added.',
        'm25.track.desStats.workshop': 'The DES Workshop is open: close it and try again.',

        'kind.mechanics.change': 'Mechanics changes from replies',
        'kind.mechanics.desStats': 'Mechanics stats in the DES tracker',
        'kind.mechanics.set': 'Mechanics values changed by hand',
        'target.mechanics.value': 'Mechanics value',
        'target.mechanics.desStats': 'Character stats in DES',
    },
    ru: {
        'm25.state.holder.world': 'Мир',
        'm25.state.source.desStats': 'статы DES',
        'm25.state.source.block': 'служебный блок',
        'm25.state.source.background': 'фоновый разбор',
        'm25.state.source.check': 'проверка',
        'm25.state.source.event': 'событие',
        'm25.state.source.user': 'вручную',
        'm25.state.journal.set': '{holder}: {attribute} теперь {value} (правка вручную)',
        'm25.state.journal.setMany': 'Значения механик изменены вручную: {count}',
        'm25.state.error.noChat': 'Чат не открыт.',
        'm25.state.error.rejected': 'Значение не изменено: {reason}.',
        'm25.state.reject.mechanic': 'этой механики нет в чате',
        'm25.state.reject.attribute': 'у механики нет такого атрибута',
        'm25.state.reject.holder': 'у этого участника нет такой механики',
        'm25.state.reject.leader': 'этот чат ведёт другая вкладка Maestro',
        'm25.state.reject.value': 'значение не подходит атрибуту',

        'm25.track.block.dropped':
            'Не смог прочитать изменения механик в ответе №{index} — убрал этот служебный блок из ответа.',
        'm25.track.block.partial':
            'Часть изменений механик в ответе №{index} не прочиталась, я их пропустил (строк: {count}).',
        'm25.track.change.title': 'Изменения механик в ответе №{index}: {count}',
        'm25.track.change.done': 'Обновил механики по ответу №{index}.',
        'm25.track.desStats.title': 'Добавить статы механики «{name}» в трекер DES?',
        'm25.track.desStats.description':
            'DES будет просить у модели эти статы для каждого персонажа в сцене: {list}. Твои собственные статы DES останутся как есть, а статы персонажей в DES включатся.',
        'm25.track.desStats.noDes': 'DES недоступен: статы добавить нельзя.',
        'm25.track.desStats.workshop': 'Открыта Мастерская DES: закрой её и попробуй ещё раз.',

        'kind.mechanics.change': 'Изменения механик по ответам',
        'kind.mechanics.desStats': 'Статы механик в трекере DES',
        'kind.mechanics.set': 'Ручные правки значений механик',
        'target.mechanics.value': 'Значение механики',
        'target.mechanics.desStats': 'Статы персонажей в DES',
    },
};
