export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  lock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}
