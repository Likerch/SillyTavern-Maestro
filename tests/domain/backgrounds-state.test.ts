import { describe, expect, it } from 'vitest';
import { placeProfile, sceneConditions } from '../../src/domain/backgrounds-score';
import {
    GENERATED_MAX,
    UNDONE_MAX,
    cssUrlPath,
    emptyPointer,
    generationTags,
    isFreeOnlyRefusal,
    isUndone,
    isUserPinned,
    libraryCssUrl,
    libraryFileOf,
    naiFreeOnly,
    readChoice,
    readPointer,
    withGenerated,
    withUndone,
} from '../../src/domain/backgrounds-state';

describe('pointer', () => {
    it('reads a stored pointer and repairs junk', () => {
        expect(readPointer(null)).toEqual(emptyPointer());
        expect(readPointer({ v: 2, url: 'x' })).toEqual(emptyPointer());
        const raw = {
            v: 1,
            url: 'url("backgrounds/a.jpg")',
            choice: { placeId: 'p1', file: 'a.jpg', variant: ['night', 3], source: 'weird', score: 'x', manual: true },
            generated: ['g.png', 5, ''],
            undone: [{ placeId: 'p1', file: 'b.jpg' }, { placeId: 1 }, 'x'],
        };
        expect(readPointer(raw)).toEqual({
            v: 1,
            url: 'url("backgrounds/a.jpg")',
            choice: { placeId: 'p1', file: 'a.jpg', variant: ['night'], source: 'library', score: 0, manual: true },
            generated: ['g.png'],
            undone: [{ placeId: 'p1', file: 'b.jpg' }],
        });
        expect(readPointer({ v: 1, url: 5, generated: 'x', undone: 'y' })).toEqual(emptyPointer());
        expect(readChoice({ placeId: '', file: 'a' })).toBeNull();
        expect(readChoice('x')).toBeNull();
        expect(readChoice({ placeId: 'p', file: 'a', source: 'generated', score: 2 })).toEqual({
            placeId: 'p',
            file: 'a',
            variant: [],
            source: 'generated',
            score: 2,
        });
    });

    it('tells a background Maestro did not write', () => {
        const pointer = { ...emptyPointer(), url: 'url("backgrounds/a.jpg")' };
        expect(isUserPinned('url("backgrounds/a.jpg")', pointer)).toBe(false);
        expect(isUserPinned('url("backgrounds/mine.jpg")', pointer)).toBe(true);
        expect(isUserPinned('', pointer)).toBe(true);
        expect(isUserPinned('', emptyPointer())).toBe(false);
        expect(isUserPinned('url("x")', emptyPointer())).toBe(true);
    });

    it('remembers undone choices and generated files, newest last and bounded', () => {
        let pointer = emptyPointer();
        for (let i = 0; i < UNDONE_MAX + 5; i++) pointer = withUndone(pointer, 'p', `f${i}.jpg`);
        pointer = withUndone(pointer, 'p', 'f10.jpg');
        expect(pointer.undone).toHaveLength(UNDONE_MAX);
        expect(pointer.undone.at(-1)).toEqual({ placeId: 'p', file: 'f10.jpg' });
        expect(isUndone(pointer, 'p', 'f10.jpg')).toBe(true);
        expect(isUndone(pointer, 'q', 'f10.jpg')).toBe(false);
        let generated = emptyPointer();
        for (let i = 0; i < GENERATED_MAX + 3; i++) generated = withGenerated(generated, `g${i}.png`);
        generated = withGenerated(generated, 'g50.png');
        expect(generated.generated).toHaveLength(GENERATED_MAX);
        expect(generated.generated.at(-1)).toBe('g50.png');
    });
});

describe('CSS values', () => {
    it('writes the value ST writes for a library file', () => {
        expect(libraryCssUrl('tavern day.jpg')).toBe('url("backgrounds/tavern%20day.jpg")');
        expect(libraryCssUrl('ночь (1).png')).toBe(`url("backgrounds/${encodeURIComponent('ночь (1).png')}")`);
    });

    it('reads the path and the library file back', () => {
        expect(cssUrlPath('url("backgrounds/a%20b.jpg")')).toBe('backgrounds/a%20b.jpg');
        expect(cssUrlPath("url('user/images/x.png')")).toBe('user/images/x.png');
        expect(cssUrlPath('url(backgrounds/c.jpg)')).toBe('backgrounds/c.jpg');
        expect(cssUrlPath('url("")')).toBeNull();
        expect(cssUrlPath('none')).toBeNull();
        expect(cssUrlPath(undefined)).toBeNull();
        expect(libraryFileOf(libraryCssUrl('tavern day.jpg'))).toBe('tavern day.jpg');
        expect(libraryFileOf('url("/backgrounds/x.png")')).toBe('x.png');
        expect(libraryFileOf('url("backgrounds/%E0%A4%A.png")')).toBe('%E0%A4%A.png');
        expect(libraryFileOf('url("user/images/chat/x.png")')).toBeNull();
        expect(libraryFileOf('')).toBeNull();
    });
});

describe('NAI Studio', () => {
    it('reads the free-only switch', () => {
        expect(naiFreeOnly({ anlas: { freeOnly: true } })).toBe(true);
        expect(naiFreeOnly({ anlas: {} })).toBe(true);
        expect(naiFreeOnly({ anlas: { freeOnly: false } })).toBe(false);
        expect(naiFreeOnly({})).toBeNull();
        expect(naiFreeOnly(null)).toBeNull();
    });

    it('recognises a free-only refusal', () => {
        expect(isFreeOnlyRefusal({ code: 'free-only-blocked' })).toBe(true);
        expect(isFreeOnlyRefusal(new Error('free-only-blocked'))).toBe(true);
        expect(isFreeOnlyRefusal('Free only mode')).toBe(true);
        expect(isFreeOnlyRefusal(new Error('network'))).toBe(false);
        expect(isFreeOnlyRefusal(42)).toBe(false);
    });

    it('builds English tags from the place and the scene', () => {
        const conditions = sceneConditions({
            time: { start: '20:00' },
            weather: { forecast: 'Гроза' },
            date: 'January 3',
        });
        expect(generationTags(placeProfile({ name: 'Разрушенная лаборатория' }), conditions)).toBe(
            'laboratory, ruins, evening, sunset, storm, lightning, rain, winter',
        );
        expect(generationTags(placeProfile({ name: 'Зал «Якорь»', parents: ['Таверна'] }), sceneConditions(null))).toBe(
            'hall',
        );
        expect(generationTags(placeProfile({ name: '«Якорь»', parents: ['Таверна'] }), sceneConditions(null))).toBe(
            'tavern',
        );
        expect(generationTags(placeProfile({ name: '«Якорь»' }), sceneConditions(null))).toBe('');
    });
});
