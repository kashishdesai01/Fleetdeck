// Floating point reductions can differ across CPU architectures. Integer structure,
// input identities and nonnumeric metadata still compare exactly.
export function assertEquivalent(
  actual: unknown,
  expected: unknown,
  path = '$',
  ignoredRootKeys: string[] = [],
): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (
      !Number.isFinite(actual) ||
      !Number.isFinite(expected) ||
      Math.abs(actual - expected) > 1e-8 + 1e-10 * Math.abs(expected)
    )
      throw new Error(`Reproduction differs at ${path}: ${actual} versus ${expected}`);
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length)
      throw new Error(`Reproduction array length differs at ${path}`);
    actual.forEach((value, index) => assertEquivalent(value, expected[index], `${path}[${index}]`));
    return;
  }
  if (
    actual !== null &&
    expected !== null &&
    typeof actual === 'object' &&
    typeof expected === 'object' &&
    !Array.isArray(actual) &&
    !Array.isArray(expected)
  ) {
    const keys = (value: object) =>
      Object.keys(value)
        .filter((key) => path !== '$' || !ignoredRootKeys.includes(key))
        .sort();
    if (JSON.stringify(keys(actual)) !== JSON.stringify(keys(expected)))
      throw new Error(`Reproduction object keys differ at ${path}`);
    for (const key of keys(actual))
      assertEquivalent(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    return;
  }
  if (actual !== expected) throw new Error(`Reproduction differs at ${path}`);
}
