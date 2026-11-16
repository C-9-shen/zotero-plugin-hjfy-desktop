/** A shared bounded queue; duplicate keys join the existing task. */
export class TaskQueue {
  private active = 0;
  private pending: (() => void)[] = [];
  private tasks = new Map<string, Promise<unknown>>();

  constructor(private readonly concurrency: number) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.tasks.get(key);
    if (existing) return existing as Promise<T>;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push(() => {
        this.active++;
        Promise.resolve()
          .then(task)
          .then(
            (value) => {
              this.complete(key);
              resolve(value);
            },
            (error) => {
              this.complete(key);
              reject(error);
            },
          );
      });
    });
    this.tasks.set(key, result);
    this.drain();
    return result;
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length)
      this.pending.shift()!();
  }

  private complete(key: string) {
    this.active--;
    this.tasks.delete(key);
    this.drain();
  }
}
