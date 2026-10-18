export interface UnitOfWork {
  /** True when `transaction` rolls every write back on failure; false for best-effort stores. */
  readonly atomic: boolean;
  /** Runs `work` so that repository calls inside it commit or roll back together. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

export const nonAtomicUnitOfWork: UnitOfWork = {
  atomic: false,
  transaction: (work) => work(),
};
