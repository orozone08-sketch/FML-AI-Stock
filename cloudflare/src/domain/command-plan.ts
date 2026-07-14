export type Mutation = Readonly<{ key: string; sql: string; params: readonly (string | number | null)[] }>;
export type CommandPlan = Readonly<{ commandType: string; idempotencyKey: string; mutations: readonly Mutation[] }>;

export function deterministicPlan(commandType: string, idempotencyKey: string, mutations: readonly Mutation[]): CommandPlan {
  if (!commandType || !idempotencyKey) throw new Error("Command type and idempotency key are required.");
  const seen = new Set<string>();
  for (const mutation of mutations) {
    if (!mutation.key || seen.has(mutation.key)) throw new Error(`Mutation keys must be unique: ${mutation.key}`);
    seen.add(mutation.key);
  }
  return Object.freeze({ commandType, idempotencyKey, mutations: Object.freeze([...mutations]) });
}

export function planFingerprint(plan: CommandPlan): string {
  return JSON.stringify(plan, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}
