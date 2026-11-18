// The result every transition function returns: the new state, or why the input is refused in
// the current state. A refusal is an expected answer (a stale click, a late event), not a bug.

export type Transition<S> = { readonly ok: true; readonly state: S } | { readonly ok: false; readonly reason: string };

export const moveTo = <S>(state: S): Transition<S> => ({ ok: true, state });

export const refuse = <S>(input: { readonly type: string }, from: string): Transition<S> => ({
  ok: false,
  reason: `${input.type} is not allowed in ${from}`,
});
