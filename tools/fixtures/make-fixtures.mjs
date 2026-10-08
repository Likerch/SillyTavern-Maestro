#!/usr/bin/env node
// Generates the bench fixtures (deterministic: the same output on every run).
//
//   node tools/fixtures/make-fixtures.mjs
//
// Output (committed): chats/*.jsonl (SillyTavern chat files), worlds/*.json (lorebooks),
// characters/*.json (spec v2 card), fixtures.json (what tools/stand/stand.mjs installs where).
// BunnyMo packs are not generated here: the bench copies them from the pinned vendor checkout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, sheetText } from '../mock-llm/scenarios.mjs';
import {
    ACTIONS,
    ALTERNATE_GREETINGS,
    ARCHIVE_NAME,
    ARCS,
    CARD_NAME,
    CHARACTERS,
    CLOSERS,
    LINES,
    PAIRS,
    SUMMARY_TEMPLATES,
    USER_NAME,
    USER_OPENERS,
    USER_TAILS,
    WEATHER,
    WORLD_FILLER,
    WORLD_LINKS,
    WORLD_NAME,
    WORLD_TOPICS,
} from './story-data.mjs';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const SEED = 20260110;
const MODEL = 'mock-deepseek-v4';
const AVATAR = 'Silver_Harbor_Chronicles.png';
const LONG_CHAT = 'reference-320';
const SHORT_CHAT = 'short-sheet';
const START = Date.parse('2026-01-10T18:00:00.000Z');

/* ------------------------------------------------------------------ helpers */

/** SillyTavern's getStringHash (public/scripts/utils.js): Qvink stores it to detect edited messages. */
function stStringHash(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? vars[key] : whole));
const iso = (ms) => new Date(ms).toISOString();

function hhmm(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ story state */

function arcAt(turn) {
    let start = 1;
    for (const [index, arc] of ARCS.entries()) {
        if (turn < start + arc.turns) return { arc, index, progress: (turn - start) / arc.turns, local: turn - start };
        start += arc.turns;
    }
    const last = ARCS.at(-1);
    return { arc: last, index: ARCS.length - 1, progress: 1, local: last.turns - 1 };
}

function relationOf(arc, name, progress) {
    const base = arc.relations[name] ?? 'Neutral';
    // People warm up during an arc; enemies stay enemies until the next arc says otherwise.
    return base === 'Neutral' && progress > 0.6 ? 'Ally' : base;
}

/** Story clock: minutes since the first evening, advanced by every turn. */
function makeStory() {
    let minutes = 18 * 60;
    let lastArc = -1;
    let day = 0;
    return (turn, rng) => {
        const at = arcAt(turn);
        if (at.index !== lastArc) {
            if (lastArc >= 0) {
                day = 0;
                minutes = (9 + Math.floor(rng() * 3)) * 60;
            }
            lastArc = at.index;
        }
        const start = minutes;
        minutes += 10 + Math.floor(rng() * 7) * 5;
        if (minutes >= 24 * 60) {
            minutes -= 24 * 60;
            day++;
        }
        const { arc, local, progress } = at;
        const castSize = Math.min(arc.cast.length, 2 + ((Math.floor(local / 6) + turn) % 2));
        const offset = Math.floor(local / 6) % arc.cast.length;
        const present = Array.from({ length: castSize }, (_, i) => arc.cast[(offset + i) % arc.cast.length]);
        const weatherKey = arc.weather[Math.floor(local / 8) % arc.weather.length];
        return {
            turn,
            arc,
            arcIndex: at.index,
            progress,
            place: arc.places[Math.floor(local / 10) % arc.places.length],
            present,
            weatherKey,
            temperature: arc.temp[0] + ((local * 7) % (arc.temp[1] - arc.temp[0] + 1)),
            date: arc.dates[Math.min(day, arc.dates.length - 1)],
            timeStart: hhmm(start),
            timeEnd: hhmm(minutes),
            event: arc.events[Math.min(arc.events.length - 1, Math.floor(progress * arc.events.length))],
        };
    };
}

/* ------------------------------------------------------------------ DES tracker */

function tracker(state, rng) {
    const { arc, present, progress } = state;
    const optional = arc.optional.filter((_, i) => progress < 0.35 * (i + 1) + 0.2).map((title) => ({ title }));
    return {
        quests: { main: { title: arc.quest }, optional },
        infoBox: {
            date: { value: state.date },
            time: { start: state.timeStart, end: state.timeEnd },
            location: { value: state.place },
            weather: { emoji: WEATHER[state.weatherKey].emoji, forecast: state.weatherKey },
            temperature: { value: state.temperature, unit: 'C' },
            recentEvents: [state.event],
        },
        characters: present.map((name) => {
            const c = CHARACTERS[name];
            return {
                name,
                emoji: c.emoji,
                details: { appearance: pick(rng, c.appearance), demeanor: pick(rng, c.demeanor) },
                relationship: { status: relationOf(arc, name, progress) },
                thoughts: { content: pick(rng, c.thoughts) },
            };
        }),
    };
}

const trackerMarkdown = (object) => '```json\n' + JSON.stringify(object, null, 2) + '\n```';

/** What DES stores in extra.dooms_tracker_swipes[swipeId] (each section as a JSON string). */
const swipeData = (object) => ({
    quests: JSON.stringify(object.quests),
    infoBox: JSON.stringify(object.infoBox),
    characterThoughts: JSON.stringify(object.characters),
});

/* ------------------------------------------------------------------ prose */

function prose(state, rng) {
    const { present, arc } = state;
    const vars = { U: USER_NAME };
    const paragraphs = [];
    const first = [pick(rng, WEATHER[state.weatherKey].phrases)];
    if (rng() < 0.7) first.push(pick(rng, arc.details));
    first.push(fill(pick(rng, ACTIONS), { ...vars, X: present[0] }));
    first.push(fill(pick(rng, LINES), { ...vars, X: present[0] }));
    paragraphs.push(first.join(' '));

    const second = [];
    const other = present[1] ?? present[0];
    second.push(fill(pick(rng, ACTIONS), { ...vars, X: other }));
    if (present.length > 1 && rng() < 0.6) second.push(fill(pick(rng, PAIRS), { X: present[0], Y: other }));
    second.push(fill(pick(rng, LINES), { ...vars, X: other }));
    if (rng() < 0.5) second.push(pick(rng, CLOSERS));
    paragraphs.push(second.join(' '));

    if (present.length > 2 || rng() < 0.3) {
        const third = present[2] ?? present[0];
        paragraphs.push(
            [pick(rng, arc.details), fill(pick(rng, ACTIONS), { ...vars, X: third }), pick(rng, CLOSERS)].join(' '),
        );
    }
    return paragraphs.join('\n\n');
}

function userText(state, rng) {
    const opener = pick(rng, USER_OPENERS);
    const act = pick(rng, state.arc.userActs);
    return `${opener} ${act}${pick(rng, USER_TAILS)}`.trim();
}

function summaryFor(state, rng) {
    if (rng() < 0.4) return `${state.event}.`;
    return fill(pick(rng, SUMMARY_TEMPLATES), { X: state.present[0], Y: state.present[1] ?? state.present[0] });
}

/* ------------------------------------------------------------------ chat messages */

function userMessage(mes, time, extra = {}) {
    return { name: USER_NAME, is_user: true, is_system: false, send_date: iso(time), mes, extra: {}, ...extra };
}

function assistantMessage(swipes, swipeId, time, trackers) {
    const genStarted = iso(time - 9000);
    const genFinished = iso(time);
    const extra = { api: 'custom', model: MODEL };
    if (trackers) extra.dooms_tracker_swipes = Object.fromEntries(trackers.map((t, i) => [String(i), swipeData(t)]));
    return {
        name: CARD_NAME,
        is_user: false,
        is_system: false,
        send_date: iso(time),
        mes: swipes[swipeId],
        extra,
        swipe_id: swipeId,
        swipes,
        swipe_info: swipes.map(() => ({
            send_date: iso(time),
            gen_started: genStarted,
            gen_finished: genFinished,
            extra: { api: 'custom', model: MODEL },
        })),
        gen_started: genStarted,
        gen_finished: genFinished,
    };
}

function imagePost(k, state, time, hidden) {
    const seed = 1000 + k * 37;
    const prompt = `harbor town, ${state.weatherKey.toLowerCase()}, ${state.present.length} characters, painterly`;
    const url = `/user/images/${CARD_NAME}/maestro-fixture-${k}.png`;
    return {
        name: CARD_NAME,
        is_user: false,
        is_system: hidden,
        send_date: iso(time),
        mes: `Иллюстрация: ${state.place}`,
        extra: {
            media: [
                {
                    url,
                    type: 'image',
                    title: prompt,
                    source: 'generated',
                    generation_type: 'free',
                    negative: 'lowres, bad anatomy',
                    width: 832,
                    height: 1216,
                    nai_studio: {
                        seed,
                        model: 'nai-diffusion-4-5-full',
                        prompt,
                        transport: 'direct',
                        cost: 0,
                        correlationId: `fixture-${k}`,
                    },
                },
            ],
            media_display: 'gallery',
            media_index: 0,
            inline_image: true,
            nai_studio: { model: 'nai-diffusion-4-5-full', seed, mode: 'free', transport: 'direct', cost: 0 },
        },
    };
}

function chatHeader(integrity) {
    return { chat_metadata: { integrity }, user_name: 'unused', character_name: 'unused' };
}

function buildLongChat(card) {
    const rng = makeRng(SEED);
    const story = makeStory();
    const totalTurns = ARCS.reduce((sum, arc) => sum + arc.turns, 0);
    const imageTurns = [40, 95, 150, 205, 260, 310];
    const images = [];
    const messages = [];
    let time = START;
    const tick = () => (time += (60 + Math.floor(rng() * 180)) * 1000);

    messages.push(assistantMessage([card.first_mes], 0, time, null));
    for (let turn = 1; turn <= totalTurns; turn++) {
        const state = story(turn, rng);
        const sheet = turn === 120;
        tick();
        if (turn === 200) {
            messages.push(
                userMessage('(OOC: давай чуть замедлим темп, хочется больше диалогов)', time, { is_system: true }),
            );
            tick();
        }
        messages.push(userMessage(sheet ? '!fullsheet Вера' : userText(state, rng), time));
        tick();

        const main = tracker(state, rng);
        let reply;
        if (sheet) {
            // The defect Maestro repairs: an unrequested scene and a tracker after the sheet.
            reply = `${sheetText('Вера', { userName: USER_NAME })}\n\n${prose(state, rng)}\n\n${trackerMarkdown(main)}`;
        } else {
            reply = `${trackerMarkdown(main)}\n\n${prose(state, rng)}`;
        }
        let message;
        if (turn % 23 === 0) {
            const alt = tracker(state, rng);
            const altReply = `${trackerMarkdown(alt)}\n\n${prose(state, rng)}`;
            message = assistantMessage([altReply, reply], 1, time, [alt, main]);
        } else {
            message = assistantMessage([reply], 0, time, [main]);
        }
        // Qvink summaries on everything but the last 40 turns; some marked "remember" (long-term memory).
        if (turn <= totalTurns - 40) {
            const remember = turn % 17 === 0;
            message.extra.qvink_memory = {
                memory: summaryFor(state, rng),
                hash: stStringHash(message.mes),
                error: null,
                edited: false,
                prefill: '',
                reasoning: '',
                remember,
                include: remember ? 'long' : turn > totalTurns - 80 ? 'short' : null,
            };
        }
        messages.push(message);

        if (imageTurns.includes(turn)) {
            tick();
            const k = images.length + 1;
            messages.push(imagePost(k, state, time, k % 2 === 1));
            images.push(k);
        }
    }
    return { header: chatHeader('3b2f6c1e-7a54-4d0e-9c1a-5e8f00a1c320'), messages, images, turns: totalTurns };
}

function buildShortChat(card) {
    const rng = makeRng(SEED + 7);
    const story = makeStory();
    const messages = [];
    let time = START + 40 * 86400000;
    messages.push(assistantMessage([card.first_mes], 0, time, null));
    for (let turn = 1; turn <= 5; turn++) {
        const state = story(turn, rng);
        time += 120000;
        const sheet = turn === 4;
        messages.push(userMessage(sheet ? '!fullsheet Мартин' : userText(state, rng), time));
        time += 30000;
        const main = tracker(state, rng);
        const reply = sheet
            ? `${sheetText('Мартин', { userName: USER_NAME })}\n\n${prose(state, rng)}\n\n${trackerMarkdown(main)}`
            : `${trackerMarkdown(main)}\n\n${prose(state, rng)}`;
        messages.push(assistantMessage([reply], 0, time, [main]));
    }
    return { header: chatHeader('9d41e2a7-0b6c-4f13-8e25-c7a95b1f0d07'), messages };
}

/* ------------------------------------------------------------------ lorebooks */

function worldEntry(uid, fields) {
    return {
        uid,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        triggers: [],
        displayIndex: uid,
        characterFilter: { isExclude: false, names: [], tags: [] },
        ...fields,
    };
}

/**
 * The big world book: 49 entries in English, every entry names three others (i+1, i+7, i+13), so one hit
 * pulls most of the book in through recursion — the shape of the real problem case.
 */
function buildWorld() {
    if (WORLD_TOPICS.length !== 49) throw new Error(`expected 49 world topics, got ${WORLD_TOPICS.length}`);
    const entries = {};
    WORLD_TOPICS.forEach(([title, keys, ruKeys, description], i) => {
        const rng = makeRng(SEED + 1000 + i);
        const linked = [1, 7, 13].map((step) => WORLD_TOPICS[(i + step) % WORLD_TOPICS.length][1][0]);
        const parts = [description, fill(pick(rng, WORLD_LINKS), { A: linked[0], B: linked[1], C: linked[2] })];
        for (let k = 0; k < i % 4; k++) parts.push(WORLD_FILLER[(i + k) % WORLD_FILLER.length]);
        const atDepth = i % 11 === 5;
        entries[String(i)] = worldEntry(i, {
            key: [...keys, ...ruKeys],
            comment: title,
            content: parts.join(' '),
            constant: i === 0 || i === WORLD_TOPICS.length - 1,
            order: 100 + (i % 10) * 10,
            position: atDepth ? 4 : i % 5 === 0 ? 1 : 0,
            excludeRecursion: i % 9 === 4,
            preventRecursion: i % 13 === 6,
        });
    });
    return { entries };
}

function archiveTags(name) {
    const c = CHARACTERS[name];
    return (
        `<BunnymoTags><Name:${name}>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:HUMAN>, <GENDER:${c.female ? 'FEMALE' : 'MALE'}>, ` +
        `<AGE:${c.age}>, <HAIRCOLOR:${c.hair}>, <EYECOLOR:${c.eyes}>, <SKINCOLOR:FAIR>, <FONT:${c.font}>, ` +
        `<BUILD:${c.build}>, <STYLE:${c.style}>, </PHYSICAL> <PERSONALITY><Dere:${c.dere}>, <${c.mbti}>, ` +
        c.traits.map((t) => `<TRAIT:${t}>`).join(', ') +
        `, <ATTACHMENT:${c.attachment}>, <CONFLICT:STRATEGIC>, <BOUNDARIES:FIRM>, <LOYALTY:PERSONAL>, <TRUST:EARNED>, ` +
        '</PERSONALITY> <NSFW><ORIENTATION:HETEROSEXUAL>, <CHEMISTRY:SLOW_BURN>, <JEALOUSY:QUIET>, </NSFW> ' +
        '<HEALTH><CONDITION:NONE>, </HEALTH></BunnymoTags>'
    );
}

/**
 * CarrotKernel character archive, as Baby Bunny Mode writes it (position 4, depth 2, role 2, order 550).
 * Keys reproduce real problems: "Вера" is also a common noun, "Александр" matches inside "Александра",
 * only Мартин has case forms.
 */
function buildArchive() {
    const people = [
        ['Элизабет', ['Элизабет', 'Элизабет Арден']],
        ['Вера', ['Вера']],
        ['Мартин', ['Мартин', 'Мартина', 'Мартину', 'Мартином', 'Мартине']],
        ['Александр', ['Александр']],
        ['Александра', ['Александра', 'Саша']],
        ['Томас', ['Томас', 'трактирщик']],
    ];
    const entries = {};
    people.forEach(([name, keys], i) => {
        const uid = 104729 + i * 7919;
        entries[String(uid)] = worldEntry(uid, {
            comment: `${name} Character Archive - Generated by Baby Bunny Mode`,
            content: archiveTags(name),
            key: keys,
            selective: true,
            order: 550,
            position: 4,
            excludeRecursion: true,
            depth: 2,
            role: 2,
            ignoreBudget: true,
            scanDepth: 1,
            caseSensitive: false,
            matchWholeWords: true,
            displayIndex: 0,
        });
        delete entries[String(uid)].characterFilter;
    });
    return { entries };
}

/* ------------------------------------------------------------------ character card */

function buildCard() {
    const description = [
        '{{char}} — рассказчик и мастер игры в мире Вельмарских пределов. {{char}} ведёт историю {{user}}, странствующего наёмника, и говорит за всех, кого тот встречает.',
        '',
        'Мир: Серебряная Гавань — вольный порт на холодном северном побережье. Вокруг — Туманные топи, маяк Святой Илзы, Старый форт и Перевал Ворона. Городом правит совет девяти по Хартии вольного порта.',
        '',
        'Главные персонажи:',
        '- Элизабет — наследница торгового дома Арден, гордая и щедрая, боится потерять место семьи в совете.',
        '- Вера — капитан портовой стражи, немногословная, наблюдательная, верна людям, а не титулам.',
        '- Мартин — алхимик и архивариус гильдии картографов, рассеянный и дотошный.',
        '- Александр — начальник порта, властный и упрямый, охраняет реестр кораблей.',
        '- Александра — картограф гильдии, сестра Александра, смелая и порывистая.',
        '- Томас — хозяин таверны «Солёный якорь», знает все слухи города.',
    ].join('\n');
    const firstMes = [
        'Дождь барабанит по ставням таверны «Солёный якорь». Томас протирает кружки и косится на дверь, будто ждёт неприятностей.',
        '',
        'За угловым столом сидит молодая женщина в тёмно-зелёном плаще. Перед ней остывает нетронутый чай, а на столе лежит свёрнутая накладная с печатью торгового дома Арден. Рядом, не снимая мокрого плаща, стоит капитан портовой стражи.',
        '',
        '«Вы ведь не из местных, — говорит Элизабет, когда {{user}} подходит ближе. — Это хорошо. Местным я больше не доверяю. Пропал груз „Северной звезды“, и стража, — она бросает короткий взгляд на Веру, — уверяет, что корабль пришёл пустым».',
        '',
        '«Я уверяю, что видела пустой трюм, — сухо поправляет Вера. — Это не одно и то же».',
    ].join('\n');
    const data = {
        name: CARD_NAME,
        description,
        personality: 'Внимательный рассказчик: живые диалоги, погода под настроение сцены, никогда не говорит за {{user}}.',
        scenario: '{{user}} приходит в таверну «Солёный якорь», где наследница дома Арден ищет помощь в поисках пропавшего груза.',
        first_mes: firstMes,
        mes_example: '<START>\n{{user}}: Что было в трюме?\n{{char}}: Вера медлит с ответом. «Ничего, — наконец говорит она. — И именно это меня беспокоит».',
        creator_notes: 'Synthetic character for the Maestro test bench. Linked world book: Velmar Reaches.',
        system_prompt: '',
        post_history_instructions: '',
        tags: ['fantasy', 'ru', 'maestro-fixture'],
        creator: 'Maestro test bench',
        character_version: '1.0',
        alternate_greetings: [...ALTERNATE_GREETINGS],
        extensions: {
            talkativeness: '0.5',
            fav: false,
            world: WORLD_NAME,
            depth_prompt: { prompt: '', depth: 4, role: 'system' },
        },
        group_only_greetings: [],
    };
    return {
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creatorcomment: data.creator_notes,
        avatar: 'none',
        chat: LONG_CHAT,
        talkativeness: '0.5',
        fav: false,
        tags: data.tags,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data,
        create_date: '2026-01-10T17:55:00.000Z',
    };
}

/* ------------------------------------------------------------------ write */

function writeJson(relative, value) {
    const file = path.join(OUT, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 4) + '\n', 'utf8');
    return fs.statSync(file).size;
}

function writeJsonl(relative, header, messages) {
    const file = path.join(OUT, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [header, ...messages].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
    return fs.statSync(file).size;
}

function main() {
    const card = buildCard();
    const long = buildLongChat(card);
    const short = buildShortChat(card);
    const sizes = {
        card: writeJson('characters/silver-harbor.json', card),
        world: writeJson(`worlds/${WORLD_NAME}.json`, buildWorld()),
        archive: writeJson(`worlds/${ARCHIVE_NAME}.json`, buildArchive()),
        longChat: writeJsonl(`chats/${LONG_CHAT}.jsonl`, long.header, long.messages),
        shortChat: writeJsonl(`chats/${SHORT_CHAT}.jsonl`, short.header, short.messages),
    };
    const manifest = {
        generatedBy: 'tools/fixtures/make-fixtures.mjs',
        user: { name: USER_NAME },
        characters: [
            {
                card: 'characters/silver-harbor.json',
                avatar: AVATAR,
                colors: { top: [38, 62, 96], bottom: [196, 160, 110] },
                activeChat: LONG_CHAT,
                chats: [
                    { file: `chats/${LONG_CHAT}.jsonl`, name: LONG_CHAT, messages: long.messages.length, turns: long.turns },
                    { file: `chats/${SHORT_CHAT}.jsonl`, name: SHORT_CHAT, messages: short.messages.length, turns: 5 },
                ],
            },
        ],
        worlds: [
            { file: `worlds/${WORLD_NAME}.json`, name: WORLD_NAME, global: false, note: 'linked to the card' },
            { file: `worlds/${ARCHIVE_NAME}.json`, name: ARCHIVE_NAME, global: true, ckRepo: true },
        ],
        images: long.images.map((k) => ({
            path: `user/images/${CARD_NAME}/maestro-fixture-${k}.png`,
            width: 64,
            height: 96,
            top: [30 + k * 20, 60, 110],
            bottom: [220, 190 - k * 15, 140],
        })),
    };
    writeJson('fixtures.json', manifest);
    console.log(
        `fixtures written to ${OUT}\n` +
            `  long chat: ${long.messages.length} messages, ${long.turns} turns, ${(sizes.longChat / 1024).toFixed(0)} KiB\n` +
            `  short chat: ${short.messages.length} messages\n` +
            `  world book: 49 entries, ${(sizes.world / 1024).toFixed(0)} KiB; archive: ${(sizes.archive / 1024).toFixed(1)} KiB`,
    );
}

main();
