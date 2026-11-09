// Strings of release 1.32 (`m44.*`): trackers and mechanics through agents.
import type { I18nParts } from '../../shared/contracts';

export const TRACKER_STRINGS: I18nParts = {
    en: {
        'kind.wardrobe.agentWear': 'Clothes changed by agents',
        'm44.recv.wardrobe.agentWear': 'What someone wears now (wardrobe)',
        'm44.recv.wearTitle': '{name}: {what}',
        'm44.src.wardrobe': 'Who wears what',
        'm44.src.staging': 'Staging (poses and positions)',
        'm44.tplGroup.trackers': 'Trackers',
        'm44.tplGroup.mechanics': 'Mechanics',
        'm44.tpl.staging.name': 'Staging',
        'm44.tpl.staging.desc':
            'After every reply keeps who is where and how: pose, place in the scene, next to whom, what they hold. The line «who is where and how» goes into the prompt; see and correct it in «World» → «Staging».',
        'm44.tpl.costumer.name': 'Costumer',
        'm44.tpl.costumer.desc':
            "After every reply notices who changed clothes and writes it into the wardrobe — a known outfit or the clothes in words. Works without DES's clothing field and for your character.",
        'm44.tpl.outfit-hint.name': 'Change of outfit',
        'm44.tpl.outfit-hint.desc':
            "Before the next reply tells the narrator when someone's clothes no longer fit the scene (night, a ball, rain, a fight, days in the same dress) and what to change into. Only for the narrator: you see it in «Turn injections».",
        'm44.tpl.own-mechanic.name': 'Own mechanic',
        'm44.tpl.own-mechanic.desc':
            "A mechanic the engine does not have — hunger, sanity, debt, fame: the values live in the agent's records, the rules in its variables, the meaning goes into the prompt. Lock a field to keep a value.",
        'm44.set.game': 'Game',
        'm44.set.game.desc':
            'Costumer, Staging, Action options. For mechanics also switch «Tracking: the agent» in Mechanics if you like.',
        'm44.set.cinema': 'Cinema',
        'm44.set.cinema.desc': 'Costumer, Staging, Change of outfit (pictures join with 1.33).',
        'm44.bi.medic.trackerRepair.title': 'Scene tracker (DES)',
        'm44.bi.medic.trackerRepair.desc':
            "Makes DES's tracker (place, time, weather, characters, quests) with DES's own prompt when a reply has none. With «Tracker by its own request» on, the main model no longer writes the tracker at all: the reply starts with the story, and the tracker comes a few seconds later.",
        'm44.bi.medic.trackerRepair.when': 'After a reply without a tracker (DES «together» mode).',
        'm44.bi.medic.trackerRepair.sources': "DES's own update prompt with its tracker settings and the reply.",
        'm44.bi.medic.trackerRepair.knob.separateTracker':
            'Tracker by its own request (the main model writes no tracker)',
        'm44.bi.medic.trackerRepair.knob.separateTracker.hint':
            "DES's tracker instruction leaves the main prompt (DES's settings stay as they are); the tracker is made right after the reply.",
    },
    ru: {
        'kind.wardrobe.agentWear': 'Переодевания от агентов',
        'm44.recv.wardrobe.agentWear': 'Во что одет сейчас (гардероб)',
        'm44.recv.wearTitle': '{name}: {what}',
        'm44.src.wardrobe': 'Кто во что одет',
        'm44.src.staging': 'Мизансцена (позы и положения)',
        'm44.tplGroup.trackers': 'Трекеры',
        'm44.tplGroup.mechanics': 'Механики',
        'm44.tpl.staging.name': 'Мизансцена',
        'm44.tpl.staging.desc':
            'После каждого ответа ведёт, кто где и как: поза, место в сцене, рядом с кем, что держит. Строка «кто где и как» идёт в промпт; посмотреть и поправить — «Мир» → «Мизансцена».',
        'm44.tpl.costumer.name': 'Костюмер',
        'm44.tpl.costumer.desc':
            'После каждого ответа замечает, кто переоделся, и пишет в гардероб — известный наряд или одежду словами. Работает без поля «Одежда» DES и для твоего персонажа.',
        'm44.tpl.outfit-hint.name': 'Смена наряда',
        'm44.tpl.outfit-hint.desc':
            'Перед следующим ответом подсказывает рассказчику, когда одежда больше не подходит сцене (ночь, бал, дождь, бой, долго в одном) и во что переодеть. Только для рассказчика: тебе видно во «Вставках хода».',
        'm44.tpl.own-mechanic.name': 'Своя механика',
        'm44.tpl.own-mechanic.desc':
            'Механика, которой нет в движке, — голод, рассудок, долг, слава: значения живут в записях агента, правила — в переменных, смысл идёт в промпт. Запри поле, чтобы удержать значение.',
        'm44.set.game': 'Игра',
        'm44.set.game.desc':
            'Костюмер, Мизансцена, Варианты действий. Для механик можно включить «Учёт: агент» в Механиках.',
        'm44.set.cinema': 'Кино',
        'm44.set.cinema.desc': 'Костюмер, Мизансцена, Смена наряда (картинки добавятся в 1.33).',
        'm44.bi.medic.trackerRepair.title': 'Трекер сцены (DES)',
        'm44.bi.medic.trackerRepair.desc':
            'Делает трекер DES (место, время, погода, персонажи, квесты) по собственному промпту DES, когда в ответе его нет. С «Трекером отдельным запросом» основная модель трекер вообще не пишет: ответ начинается сразу с истории, а трекер приходит через несколько секунд.',
        'm44.bi.medic.trackerRepair.when': 'После ответа без трекера (режим DES «вместе»).',
        'm44.bi.medic.trackerRepair.sources': 'Собственный промпт обновления DES с его настройками трекера и ответ.',
        'm44.bi.medic.trackerRepair.knob.separateTracker':
            'Трекер отдельным запросом (основная модель трекер не пишет)',
        'm44.bi.medic.trackerRepair.knob.separateTracker.hint':
            'Инструкция трекера DES уходит из основного промпта (настройки DES не меняются); трекер делается сразу после ответа.',
    },
};
