import type { Condition, Effect, Scalar, Variables } from "./types";

const comparable = (value: Scalar): value is string | number => typeof value === "string" || typeof value === "number";

export function evaluateCondition(condition: Condition, variables: Variables): boolean {
  const actual = variables[condition.variable] ?? null;
  const expected = condition.value;
  switch (condition.operator) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return comparable(actual) && comparable(expected as Scalar) && actual > (expected as string | number);
    case "gte": return comparable(actual) && comparable(expected as Scalar) && actual >= (expected as string | number);
    case "lt": return comparable(actual) && comparable(expected as Scalar) && actual < (expected as string | number);
    case "lte": return comparable(actual) && comparable(expected as Scalar) && actual <= (expected as string | number);
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "truthy": return Boolean(actual);
    case "falsy": return !actual;
  }
}

export function evaluateAll(conditions: Condition[], variables: Variables): boolean {
  return conditions.every((condition) => evaluateCondition(condition, variables));
}

export function applyEffects(variables: Variables, effects: Effect[] = []): Variables {
  const next = { ...variables };
  for (const effect of effects) {
    const current = next[effect.variable];
    switch (effect.operation) {
      case "set": next[effect.variable] = effect.value ?? null; break;
      case "increment": next[effect.variable] = Number(current ?? 0) + Number(effect.value ?? 1); break;
      case "decrement": next[effect.variable] = Number(current ?? 0) - Number(effect.value ?? 1); break;
      case "toggle": next[effect.variable] = !Boolean(current); break;
    }
  }
  return next;
}
