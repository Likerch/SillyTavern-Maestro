// R3 measurements on the bench (dev-plan 4.6, plan §14): pure helpers of tools/stand/measure.mjs. They classify the
// requests the mock LLM recorded, find lorebook entries inside prompts, group requests into turns, summarise a run,
// compare two runs (lore with and without Maestro's rules), read Maestro's per-chat metrics documents and pack
// fingerprints, and render docs-ready Markdown. No I/O here: measure.mjs reads the files.
// JSDoc types serve the TypeScript tests (allowJs); the script itself is plain Node 20 JavaScript.
import { contentText, normalizeText } from './snapshot-lib.mjs';

/** Where a request came from. 'main' = the chat reply; 'maestro' = Maestro's own tasks and assistant tools. */
export const KINDS = ['main', 'maestro', 'qvink', 'nai', 'other'];

/** Plan §14 targets the bench can check. */
export const TARGETS = {
    latencyMs: { desktop: 200, phone: 600 },
    costShare: 0.15,
    loreRatio: 0.5,
    minLatencySamples: 20,
    costWindowTurns: 100,
};

const MAIN_SCENARIOS = new Set(['story', 'sheet', 'refusal', 'repeat']);

/**
 * @typedef {{ n: number, mean?: number, p50?: number, p95?: number, max?: number }} Dist
 * @typedef {{ book: string, uid: number, comment: string, chars: number }} LoreHit
 * @typedef {{ book: string, uid: number, comment: string, probe: string, chars: number }} LoreProbe
 * @typedef {{ chars: number, entries: LoreHit[], byBook: Record<string, { entries: number, chars: number }> }} LoreFound
 * @typedef {{ n: number, at: number, kind: string, scenario: string, status: number, model: string | null,
 *   messages: number, chars: number, bytes: number, promptTokens: number, completionTokens: number, cost: number,
 *   lore: LoreFound, loreShare: number }} Row
 * @typedef {{ index: number, main: Row, background: Row[] }} Turn
 * @typedef {{ requests: number, cost: number, promptTokens: number, completionTokens: number }} KindTotals
 * @typedef {{ name: string, installed: { sha256: string, bytes: number } | null,
 *   source: { sha256: string, bytes: number } | null }} PackPair
 */

/* ------------------------------------------------------------------ numbers */

/**
 * Nearest-rank percentile (same rule as src/domain/metrics-stats.ts).
 * @param {unknown[]} values
 * @param {number} p
 * @returns {number | undefined}
 */
export function percentile(values, p) {
    const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!list.length) return undefined;
    const clamped = Math.min(100, Math.max(0, Number.isFinite(p) ? p : 0));
    const rank = Math.ceil((clamped / 100) * list.length);
    return list[Math.max(0, rank - 1)];
}

/**
 * @param {unknown[]} values
 * @returns {Dist}
 */
export function distribution(values) {
    const list = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (!list.length) return { n: 0 };
    return {
        n: list.length,
        mean: list.reduce((sum, v) => sum + v, 0) / list.length,
        p50: percentile(list, 50),
        p95: percentile(list, 95),
        max: Math.max(...list),
    };
}

/** @param {unknown} text */
export function utf8Length(text) {
    return new TextEncoder().encode(String(text ?? '')).length;
}

/* ------------------------------------------------------------------ recorded requests */

/**
 * Kind of a recorded request, from the mock's scenario label and the request body.
 * @param {any} record
 * @returns {string}
 */
export function classifyRequest(record) {
    const scenario = String(record?.scenario ?? '');
    const base = scenario.split('+')[0];
    const format = record?.body?.response_format;
    const schema =
        (format?.type === 'json_schema' && format.json_schema?.name) ||
        (base.startsWith('schema:') ? base.slice('schema:'.length).replace(/\(walker\)$/, '') : '');
    if (base === 'summary') return 'qvink';
    if (schema) {
        if (/^maestro/i.test(schema)) return 'maestro';
        if (/^nai/i.test(schema)) return 'nai';
        return 'other';
    }
    if (base === 'tool-call' || base === 'tool-result') return 'maestro';
    if (MAIN_SCENARIOS.has(base)) return 'main';
    return 'other';
}

/**
 * Arrival time (ms): `receivedAt` when the mock records it, else the ISO `time`.
 * @param {any} record
 * @returns {number}
 */
export function recordTime(record) {
    const received = Number(record?.receivedAt);
    if (Number.isFinite(received) && received > 0) return received;
    const parsed = Date.parse(record?.time ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Request size in bytes: the raw body size when recorded (`bodyBytes`), else the JSON of the parsed body.
 * @param {any} record
 * @returns {number}
 */
export function recordBytes(record) {
    const recorded = Number(record?.bodyBytes);
    if (Number.isFinite(recorded) && recorded >= 0) return recorded;
    return utf8Length(JSON.stringify(record?.body ?? {}));
}

/**
 * The prompt as one normalised text (message contents joined).
 * @param {any} body
 * @returns {string}
 */
export function promptText(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    return messages.map((message) => normalizeText(contentText(message?.content))).join('\n');
}

/* ------------------------------------------------------------------ lore in prompts */

/**
 * Probes for lorebook entries: the start of the longest macro-free piece of each enabled entry, and the entry's
 * normalised length. `worlds` is [{ name, data: { entries } }] as in snapshot-lib's buildProbes.
 * @param {any[] | undefined} worlds
 * @param {{ minLength?: number, probeLength?: number }} [options]
 * @returns {LoreProbe[]}
 */
export function buildLoreIndex(worlds, { minLength = 24, probeLength = 64 } = {}) {
    /** @type {LoreProbe[]} */
    const index = [];
    for (const world of worlds ?? []) {
        for (const entry of Object.values(world?.data?.entries ?? {})) {
            if (!entry || entry.disable) continue;
            const content = String(entry.content ?? '');
            const pieces = content.split(/\{\{[^}]*\}\}/).map(normalizeText);
            const longest = pieces.sort((a, b) => b.length - a.length)[0] ?? '';
            if (longest.length < minLength) continue;
            index.push({
                book: world.name,
                uid: entry.uid,
                comment: entry.comment ?? '',
                probe: longest.slice(0, probeLength),
                chars: normalizeText(content).length,
            });
        }
    }
    return index;
}

/**
 * Entries of the index whose probe occurs in the text, with their characters per book.
 * @param {string} text
 * @param {LoreProbe[] | undefined} index
 * @returns {LoreFound}
 */
export function loreInText(text, index) {
    /** @type {LoreFound} */
    const result = { chars: 0, entries: [], byBook: {} };
    for (const item of index ?? []) {
        if (!text.includes(item.probe)) continue;
        result.chars += item.chars;
        result.entries.push({ book: item.book, uid: item.uid, comment: item.comment, chars: item.chars });
        result.byBook[item.book] ??= { entries: 0, chars: 0 };
        result.byBook[item.book].entries++;
        result.byBook[item.book].chars += item.chars;
    }
    return result;
}

/**
 * One row per recorded request.
 * @param {any} record
 * @param {LoreProbe[]} [index]
 * @returns {Row}
 */
export function analyseRecord(record, index = []) {
    const body = record?.body ?? {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const text = promptText(body);
    const usage = record?.response?.usage ?? null;
    const kind = classifyRequest(record);
    /** @type {LoreFound} */
    const lore = kind === 'main' ? loreInText(text, index) : { chars: 0, entries: [], byBook: {} };
    const chars = messages.reduce((sum, message) => sum + contentText(message?.content).length, 0);
    return {
        n: Number(record?.n) || 0,
        at: recordTime(record),
        kind,
        scenario: String(record?.scenario ?? ''),
        status: Number(record?.response?.status ?? 0),
        model: body.model ?? null,
        messages: messages.length,
        chars,
        bytes: recordBytes(record),
        promptTokens: Number(usage?.prompt_tokens) || 0,
        completionTokens: Number(usage?.completion_tokens) || 0,
        cost: Number(usage?.cost) || 0,
        lore,
        loreShare: chars > 0 ? lore.chars / chars : 0,
    };
}

/**
 * A turn = a main request plus every other request until the next main one.
 * @param {Row[]} rows
 * @returns {{ turns: Turn[], preamble: Row[] }}
 */
export function groupTurns(rows) {
    const sorted = [...rows].sort((a, b) => a.at - b.at || a.n - b.n);
    /** @type {Turn[]} */
    const turns = [];
    /** @type {Row[]} */
    const preamble = [];
    for (const row of sorted) {
        if (row.kind === 'main') turns.push({ index: turns.length + 1, main: row, background: [] });
        else if (turns.length) turns[turns.length - 1].background.push(row);
        else preamble.push(row);
    }
    return { turns, preamble };
}

/**
 * Everything the report says about one run of recorded requests.
 * @param {Row[]} rows
 */
export function summarizeRun(rows) {
    const { turns, preamble } = groupTurns(rows);
    const mains = turns.map((turn) => turn.main);
    /** @type {Record<'main' | 'maestro' | 'qvink' | 'nai' | 'other', KindTotals>} */
    const byKind = {};
    for (const kind of KINDS) byKind[kind] = { requests: 0, cost: 0, promptTokens: 0, completionTokens: 0 };
    for (const row of rows) {
        const slot = byKind[row.kind] ?? byKind.other;
        slot.requests++;
        slot.cost += row.cost;
        slot.promptTokens += row.promptTokens;
        slot.completionTokens += row.completionTokens;
    }
    const gaps = [];
    for (let i = 1; i < mains.length; i++) gaps.push(mains[i].at - mains[i - 1].at);
    const mainCost = byKind.main.cost;
    return {
        requests: rows.length,
        failed: rows.filter((row) => row.status >= 400 || row.status === 0).length,
        turns: turns.length,
        preamble: preamble.length,
        from: rows.length ? Math.min(...rows.map((row) => row.at)) : 0,
        to: rows.length ? Math.max(...rows.map((row) => row.at)) : 0,
        perTurn: distribution(turns.map((turn) => 1 + turn.background.length)),
        backgroundPerTurn: distribution(turns.map((turn) => turn.background.length)),
        prompt: {
            chars: distribution(mains.map((row) => row.chars)),
            bytes: distribution(mains.map((row) => row.bytes)),
            tokens: distribution(mains.map((row) => row.promptTokens)),
            messages: distribution(mains.map((row) => row.messages)),
        },
        lore: {
            chars: distribution(mains.map((row) => row.lore.chars)),
            entries: distribution(mains.map((row) => row.lore.entries.length)),
            share: distribution(mains.map((row) => row.loreShare)),
        },
        byKind,
        backgroundShare: mainCost > 0 ? byKind.maestro.cost / mainCost : undefined,
        gaps: distribution(gaps),
    };
}

/**
 * Keys of entries seen in a run's main prompts → { book, uid, comment, turns }.
 * @param {Row[]} rows
 */
function entriesSeen(rows) {
    /** @type {Map<string, { book: string, uid: number, comment: string, turns: number }>} */
    const seen = new Map();
    for (const row of rows) {
        if (row.kind !== 'main') continue;
        for (const entry of row.lore.entries) {
            const key = `${entry.book}#${entry.uid}`;
            const item = seen.get(key) ?? { book: entry.book, uid: entry.uid, comment: entry.comment, turns: 0 };
            item.turns++;
            seen.set(key, item);
        }
    }
    return seen;
}

/**
 * Criterion 3 on the bench: the same reference turns recorded twice (baseline: Maestro's lore rules off; current:
 * on). Lore per turn is compared by averages and turn by turn; entries that never reach the current prompts are
 * listed for the manual "was it needed?" check.
 * @param {Row[]} baseRows
 * @param {Row[]} currentRows
 */
export function compareRuns(baseRows, currentRows) {
    const base = groupTurns(baseRows).turns.map((turn) => turn.main);
    const current = groupTurns(currentRows).turns.map((turn) => turn.main);
    /** @type {(list: Row[], pick: (row: Row) => number) => number | undefined} */
    const mean = (list, pick) =>
        list.length ? list.reduce((sum, row) => sum + pick(row), 0) / list.length : undefined;
    const baseLore = mean(base, (row) => row.lore.chars);
    const currentLore = mean(current, (row) => row.lore.chars);
    const basePrompt = mean(base, (row) => row.chars);
    const currentPrompt = mean(current, (row) => row.chars);
    const pairs = Math.min(base.length, current.length);
    const perTurn = [];
    for (let i = 0; i < pairs; i++) {
        if (base[i].lore.chars > 0) perTurn.push(current[i].lore.chars / base[i].lore.chars);
    }
    const before = entriesSeen(baseRows);
    const after = entriesSeen(currentRows);
    const lost = [...before].filter(([key]) => !after.has(key)).map(([, item]) => item);
    const added = [...after].filter(([key]) => !before.has(key)).map(([, item]) => item);
    const byTurns = (a, b) => b.turns - a.turns || String(a.book).localeCompare(String(b.book)) || a.uid - b.uid;
    return {
        turns: { base: base.length, current: current.length, paired: pairs },
        lore: {
            base: baseLore,
            current: currentLore,
            ratio: baseLore && currentLore !== undefined ? currentLore / baseLore : undefined,
        },
        prompt: {
            base: basePrompt,
            current: currentPrompt,
            ratio: basePrompt && currentPrompt !== undefined ? currentPrompt / basePrompt : undefined,
        },
        perTurnRatio: distribution(perTurn),
        lost: lost.sort(byTurns),
        added: added.sort(byTurns),
    };
}

/* ------------------------------------------------------------------ Maestro's metrics document */

/**
 * Reads `maestro-chat-<hash>-metrics.json` (the chat store envelope { schema, version, data } or bare data) and
 * summarises it the way the pult tab does: send path per device, background cost share over the last
 * `windowTurns` turns, lore per turn, the zero counters.
 * @param {any} raw
 * @param {{ windowTurns?: number }} [options]
 */
export function metricsFromDoc(raw, { windowTurns = TARGETS.costWindowTurns } = {}) {
    const data = raw && typeof raw === 'object' && 'data' in raw && raw.data ? raw.data : raw;
    const turns = Array.isArray(data?.turns) ? data.turns.filter((t) => t && Number.isFinite(t.at)) : [];
    const costs = Array.isArray(data?.costs) ? data.costs.filter((c) => c && Number.isFinite(c.at)) : [];
    const counters = data?.counters && typeof data.counters === 'object' ? data.counters : {};
    /** @type {Record<'desktop' | 'phone', { send: Dist, window: Dist, maestro: Dist }>} */
    const latency = {};
    for (const device of ['desktop', 'phone']) {
        const own = turns.filter((t) => (t.device === 'phone' ? 'phone' : 'desktop') === device);
        latency[device] = {
            send: distribution(own.map((t) => t.sendMs)),
            window: distribution(own.map((t) => t.windowMs)),
            maestro: distribution(own.map((t) => t.maestroMs)),
        };
    }
    const sorted = [...turns].sort((a, b) => a.at - b.at);
    const window = sorted.slice(-Math.max(1, windowTurns));
    const from = window[0]?.at ?? 0;
    const ownerAuto = (at) => {
        let auto = false;
        for (const turn of window) {
            if (turn.at <= at) auto = turn.auto === true;
            else break;
        }
        return auto;
    };
    const cost = { main: 0, maestro: 0, autoSwipes: 0, qvink: 0, other: 0 };
    for (const entry of costs) {
        if (entry.at < from) continue;
        const usd = Number(entry.usd) > 0 ? Number(entry.usd) : 0;
        if (entry.source === 'main') {
            if (ownerAuto(entry.at)) cost.autoSwipes += usd;
            else cost.main += usd;
        } else if (entry.source === 'maestro') cost.maestro += usd;
        else if (entry.source === 'qvink') cost.qvink += usd;
        else cost.other += usd;
    }
    const background = cost.maestro + cost.autoSwipes;
    const checked = turns.filter((t) => Number.isFinite(t.dropped));
    const withLore = turns.filter((t) => Number.isFinite(t.assistantDepth));
    return {
        turns: turns.length,
        startedAt: Number(data?.startedAt) || 0,
        latency,
        cost: { ...cost, turns: window.length, share: cost.main > 0 ? background / cost.main : undefined },
        lore: {
            chars: distribution(turns.map((t) => t.loreChars)),
            baseline: data?.baseline ?? null,
            whatIf: data?.whatIf ?? null,
        },
        dropped: turnCounts(checked.map((t) => t.dropped)),
        assistantDepth: turnCounts(withLore.map((t) => t.assistantDepth)),
        counters,
    };
}

/**
 * Per-turn occurrences (same rule as turnCounts in src/domain/metrics-checks.ts): a message dropped once is dropped
 * again on every later turn, so the report shows turns with occurrences and the worst turn, not only the sum.
 * @param {number[]} values
 */
export function turnCounts(values) {
    const result = { turns: values.length, turnsWith: 0, max: 0, total: 0 };
    for (const value of values) {
        result.total += value;
        if (value > 0) result.turnsWith++;
        result.max = Math.max(result.max, value);
    }
    return result;
}

/* ------------------------------------------------------------------ BunnyMo pack files */

/**
 * Criterion 10: installed pack files against the pinned BunnyMo export. Each pair carries sha256 and size (or
 * null when the file is missing).
 * @param {PackPair[]} pairs
 */
export function packIntegrity(pairs) {
    const rows = pairs.map((pair) => {
        let status;
        if (!pair.source) status = 'no-source';
        else if (!pair.installed) status = 'not-installed';
        else if (pair.installed.sha256 === pair.source.sha256 && pair.installed.bytes === pair.source.bytes) {
            status = 'same';
        } else status = 'changed';
        return { name: pair.name, status, bytes: pair.installed?.bytes ?? pair.source?.bytes ?? 0 };
    });
    const count = (status) => rows.filter((row) => row.status === status).length;
    return {
        rows,
        same: count('same'),
        changed: count('changed'),
        notInstalled: count('not-installed'),
        noSource: count('no-source'),
        ok: rows.length > 0 && count('changed') === 0 && count('not-installed') === 0,
    };
}

/* ------------------------------------------------------------------ Markdown */

const fmt = (value, digits = 0) =>
    value === undefined || value === null || !Number.isFinite(value)
        ? '—'
        : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
const pct = (share, digits = 1) =>
    share === undefined || !Number.isFinite(share) ? '—' : `${fmt(share * 100, digits)} %`;
const usd = (value) => (Number.isFinite(value) ? `$${value.toFixed(value !== 0 && value < 0.01 ? 5 : 4)}` : '—');
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mark = (ok) => (ok === undefined ? '—' : ok ? '✅' : '⚠');

/**
 * @param {string[]} headers
 * @param {string[][]} rows
 */
export function markdownTable(headers, rows) {
    const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;
    return [line(headers), `|${headers.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

function distRow(label, d, digits = 0) {
    return [label, fmt(d.n), fmt(d.mean, digits), fmt(d.p50, digits), fmt(d.p95, digits), fmt(d.max, digits)];
}

/**
 * The report: `run` from summarizeRun, optional `comparison` (compareRuns), `metrics` ([{ file, summary }] from
 * metricsFromDoc), `packs` (packIntegrity), `meta` ({ dir, baselineDir, generatedAt }).
 * @param {{ run: ReturnType<typeof summarizeRun>, comparison?: ReturnType<typeof compareRuns> | null,
 *   metrics?: { file: string, summary: ReturnType<typeof metricsFromDoc> }[],
 *   packs?: ReturnType<typeof packIntegrity> | null, meta?: { dir?: string, baselineDir?: string, generatedAt?: number } }} report
 * @returns {string}
 */
export function renderReport({ run, comparison = null, metrics = [], packs = null, meta = {} }) {
    const lines = [];
    const iso = (ms) => (ms ? new Date(ms).toISOString() : '—');
    lines.push('# Замеры на стенде (критерии R3)', '');
    lines.push(
        `Запросы: \`${meta.dir ?? '?'}\`${meta.baselineDir ? `, база для сравнения: \`${meta.baselineDir}\`` : ''}. ` +
            `Сформировано ${iso(meta.generatedAt)}. Период: ${iso(run.from)} — ${iso(run.to)}.`,
        '',
    );

    lines.push('## Сводка по критериям', '');
    const doc = metrics[0]?.summary;
    // Criterion 1 is Maestro's ADDED latency (its own code on the send path), not ST's lore scan and assembly.
    const latencyOk = (device) => {
        const own = doc?.latency[device]?.maestro;
        if (!own || own.n < TARGETS.minLatencySamples || own.p95 === undefined) return undefined;
        return own.p95 <= TARGETS.latencyMs[device];
    };
    const latencyCell = (device) => {
        const own = doc?.latency[device]?.maestro;
        return own?.n ? `${fmt(own.p95)} мс кода Maestro (замеров: ${own.n})` : 'нет замеров';
    };
    const rows = [
        [
            '1. Задержка до запроса, p95',
            '≤ 200 мс ПК / ≤ 600 мс телефон',
            `ПК: ${latencyCell('desktop')}; телефон: ${latencyCell('phone')}`,
            mark(
                latencyOk('desktop') === false || latencyOk('phone') === false
                    ? false
                    : (latencyOk('desktop') ?? latencyOk('phone')),
            ),
            'документ замеров Maestro (браузер стенда): перехватчик и обработчики Maestro',
        ],
        [
            '2. Фоновые расходы / основная модель',
            '≤ 15 %',
            `стенд: ${pct(run.backgroundShare)}${doc ? `; по документу: ${pct(doc.cost.share)}` : ''}`,
            mark(run.backgroundShare === undefined ? undefined : run.backgroundShare <= TARGETS.costShare),
            'usage.cost ответов имитации (цены условные)',
        ],
        [
            '3. Символы лора на ход',
            '≤ 50 % от прогона без правил',
            comparison
                ? `${pct(comparison.lore.ratio)} (${fmt(comparison.lore.current)} из ${fmt(comparison.lore.base)})`
                : 'нет базового прогона (--baseline)',
            mark(comparison?.lore.ratio === undefined ? undefined : comparison.lore.ratio <= TARGETS.loreRatio),
            'записи книг, найденные в промптах двух прогонов',
        ],
        [
            '4. Выпавшие без пересказа',
            '0',
            doc
                ? `ходов с выпавшими: ${doc.dropped.turnsWith} из ${doc.dropped.turns} (больше всего за ход: ${doc.dropped.max})`
                : 'нет документа замеров',
            mark(doc && doc.dropped.turns ? doc.dropped.turnsWith === 0 : undefined),
            'документ замеров Maestro',
        ],
        [
            '5. Лор с ролью assistant на глубине',
            '0',
            doc
                ? `ходов с такими записями: ${doc.assistantDepth.turnsWith} из ${doc.assistantDepth.turns}`
                : 'нет документа замеров',
            mark(doc && doc.assistantDepth.turns ? doc.assistantDepth.turnsWith === 0 : undefined),
            'документ замеров Maestro (журнал лора)',
        ],
        [
            '10. Файлы паков BunnyMo',
            'побайтно как в выгрузке',
            packs
                ? `совпадают: ${packs.same}, изменены: ${packs.changed}, нет файла: ${packs.notInstalled}`
                : 'не проверялись',
            mark(packs ? packs.ok : undefined),
            'sha256 установленных файлов против закреплённой выгрузки',
        ],
    ];
    lines.push(markdownTable(['Критерий', 'Цель', 'Сейчас', 'Статус', 'Как измерено'], rows), '');
    lines.push(
        'Критерии 6–9 (откаты вкладок и потери данных, доля принятых предложений, пробные факты, листы) на стенде ' +
            'проверяются вручную или только в живой игре — их показывает вкладка «Замеры» в пульте.',
        '',
    );

    lines.push('## Запросы', '');
    lines.push(
        markdownTable(
            ['Источник', 'Запросов', 'Токены на вход', 'Токены на выход', 'Стоимость'],
            KINDS.map((kind) => {
                const slot = run.byKind[kind];
                return [kind, fmt(slot.requests), fmt(slot.promptTokens), fmt(slot.completionTokens), usd(slot.cost)];
            }),
        ),
        '',
    );
    lines.push(
        `Ходов (основных запросов): ${run.turns}; запросов всего: ${run.requests}, из них с ошибкой: ${run.failed}; ` +
            `до первого хода: ${run.preamble}.`,
        '',
    );
    lines.push(
        markdownTable(
            ['На ход', 'n', 'среднее', 'p50', 'p95', 'max'],
            [
                distRow('запросов (вместе с основным)', run.perTurn, 2),
                distRow('фоновых запросов', run.backgroundPerTurn, 2),
                distRow('символов промпта', run.prompt.chars),
                distRow('байт тела запроса', run.prompt.bytes),
                distRow('токенов промпта (оценка имитации)', run.prompt.tokens),
                distRow('сообщений в промпте', run.prompt.messages),
                distRow('символов лора (найдено в промпте)', run.lore.chars),
                distRow('записей лора', run.lore.entries, 1),
                distRow(
                    'доля лора в промпте, %',
                    {
                        ...run.lore.share,
                        mean: run.lore.share.mean === undefined ? undefined : run.lore.share.mean * 100,
                        p50: run.lore.share.p50 === undefined ? undefined : run.lore.share.p50 * 100,
                        p95: run.lore.share.p95 === undefined ? undefined : run.lore.share.p95 * 100,
                        max: run.lore.share.max === undefined ? undefined : run.lore.share.max * 100,
                    },
                    1,
                ),
                distRow('мс между ходами', run.gaps),
            ],
        ),
        '',
    );

    if (comparison) {
        lines.push('## Лор: сравнение с прогоном без правил', '');
        lines.push(
            markdownTable(
                ['', 'без правил', 'с правилами', 'отношение'],
                [
                    [
                        'ходов',
                        fmt(comparison.turns.base),
                        fmt(comparison.turns.current),
                        `пар: ${comparison.turns.paired}`,
                    ],
                    [
                        'символов лора на ход',
                        fmt(comparison.lore.base),
                        fmt(comparison.lore.current),
                        pct(comparison.lore.ratio),
                    ],
                    [
                        'символов промпта на ход',
                        fmt(comparison.prompt.base),
                        fmt(comparison.prompt.current),
                        pct(comparison.prompt.ratio),
                    ],
                ],
            ),
            '',
        );
        lines.push(
            `Отношение по ходам (пары): p50 ${pct(comparison.perTurnRatio.p50)}, p95 ${pct(comparison.perTurnRatio.p95)}.`,
            '',
        );
        if (comparison.lost.length) {
            lines.push(
                'Записи, которые без правил попадали в промпт, а с правилами — ни разу (проверь, нужны ли они сцене):',
                '',
            );
            for (const item of comparison.lost.slice(0, 40)) {
                lines.push(`- ${item.book} #${item.uid} «${item.comment}» — ходов без правил: ${item.turns}`);
            }
            if (comparison.lost.length > 40) lines.push(`- … ещё ${comparison.lost.length - 40}`);
            lines.push('');
        }
    }

    for (const { file, summary } of metrics) {
        lines.push(`## Документ замеров Maestro: \`${file}\``, '');
        lines.push(`Ходов: ${summary.turns}, с ${iso(summary.startedAt)}.`, '');
        lines.push(
            markdownTable(
                ['Устройство', 'замеров', 'p50, мс', 'p95, мс', 'max, мс', 'p95 всего пути ST', 'p95 кода Maestro'],
                ['desktop', 'phone'].map((device) => {
                    const d = summary.latency[device];
                    return [
                        device === 'desktop' ? 'ПК' : 'телефон',
                        fmt(d.send.n),
                        fmt(d.send.p50, 1),
                        fmt(d.send.p95, 1),
                        fmt(d.send.max, 1),
                        fmt(d.window.p95, 1),
                        fmt(d.maestro.p95, 2),
                    ];
                }),
            ),
            '',
        );
        lines.push(
            `Расходы в окне (${summary.cost.turns} ходов): основная модель ${usd(summary.cost.main)}, Maestro ` +
                `${usd(summary.cost.maestro)}, авто-свайпы ${usd(summary.cost.autoSwipes)}, Qvink ${usd(summary.cost.qvink)}; ` +
                `доля фона ${pct(summary.cost.share)}.`,
            '',
        );
        const counters = Object.entries(summary.counters);
        if (counters.length) {
            lines.push(`Счётчики: ${counters.map(([name, value]) => `${name} = ${value}`).join(', ')}.`, '');
        }
    }

    if (packs) {
        lines.push('## Файлы паков BunnyMo', '');
        lines.push(
            markdownTable(
                ['Файл', 'Статус', 'Байт'],
                packs.rows.map((row) => [row.name, row.status, fmt(row.bytes)]),
            ),
            '',
        );
    }
    return lines.join('\n');
}

/* ------------------------------------------------------------------ arguments */

const VALUE_FLAGS = new Set([
    'dir',
    'mock',
    'baseline',
    'files',
    'worlds',
    'from',
    'to',
    'last',
    'out',
    'window',
    'metrics',
]);

/**
 * @param {string[]} argv
 * @returns {Record<string, any> & { _: string[] }}
 */
export function parseArgs(argv) {
    /** @type {Record<string, any> & { _: string[] }} */
    const options = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            options._.push(arg);
            continue;
        }
        const [flag, inline] = arg.slice(2).split('=', 2);
        if (VALUE_FLAGS.has(flag)) options[flag] = inline ?? argv[++i];
        else options[flag] = inline ?? true;
    }
    return options;
}

/**
 * Keeps the records selected by --from/--to (request numbers) and --last (the newest N).
 * @template {{ n?: unknown }} T
 * @param {T[]} records
 * @param {{ from?: unknown, to?: unknown, last?: unknown }} [options]
 * @returns {T[]}
 */
export function selectRecords(records, { from, to, last } = {}) {
    let list = [...records].sort((a, b) => (Number(a.n) || 0) - (Number(b.n) || 0));
    if (from !== undefined) list = list.filter((record) => Number(record.n) >= Number(from));
    if (to !== undefined) list = list.filter((record) => Number(record.n) <= Number(to));
    if (last !== undefined) {
        const count = Math.max(0, Math.floor(Number(last)) || 0);
        list = count ? list.slice(-count) : [];
    }
    return list;
}
