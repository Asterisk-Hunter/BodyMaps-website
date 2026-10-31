/** Start independent full-resolution reads together, not a CT -> mask waterfall.
 * Ownership, abort and release stay with the caller's existing resource context.
 */
export async function parallelPair<A, B>(left: () => Promise<A>, right: () => Promise<B>): Promise<[A, B]> {
  return Promise.all([Promise.resolve().then(left), Promise.resolve().then(right)]);
}
