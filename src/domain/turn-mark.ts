/**
 * "Processed up to message N" marks kept in per-chat documents.
 *
 * A mark can point past the end of the chat when messages were deleted while Maestro was off, in another tab or
 * before the module listened (or the chat file was replaced). Such a mark would make every new turn look already
 * processed until the chat grows past it again, so it is treated as "nothing processed yet".
 */
export function freshMark(mark: number, chatLength: number): number {
    if (!Number.isFinite(mark)) return -1;
    return mark >= chatLength ? -1 : mark;
}
