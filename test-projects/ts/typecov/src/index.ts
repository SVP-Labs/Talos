const raw: unknown = JSON.parse('{"a":1}');

export const a = (raw as { a: number }).a;
export const b = (raw as { b?: string }).b ?? '';
export const c = [1, 2, 3][0]!;
