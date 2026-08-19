export interface ReviewInvocationLifecycle<Context, Status> {
  active: (ctx: Context) => Status;
  failed: (ctx: Context, error: unknown) => Status;
  completed: (ctx: Context) => void;
  starting: () => Status;
}

class ReviewInvocationLease {
  private released = false;

  constructor(private readonly releaseLease: () => void) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseLease();
  }
}

export class ReviewInvocationCoordinator<Context, Status> {
  private activeLease: ReviewInvocationLease | null = null;

  constructor(private readonly lifecycle: ReviewInvocationLifecycle<Context, Status>) {}

  runAwaited(
    ctx: Context,
    invocation: () => Promise<Status>,
    onSuccess?: (status: Status) => void,
  ): Promise<Status> {
    const lease = this.acquire();
    if (lease == null) return Promise.resolve(this.lifecycle.active(ctx));
    return this.complete(lease, ctx, invocation, onSuccess);
  }

  runDetached(
    ctx: Context,
    invocation: () => Promise<Status>,
    onSuccess?: (status: Status) => void,
  ): Status {
    const lease = this.acquire();
    if (lease == null) return this.lifecycle.active(ctx);
    void this.complete(lease, ctx, invocation, onSuccess);
    return this.lifecycle.starting();
  }

  private acquire(): ReviewInvocationLease | null {
    if (this.activeLease != null) return null;

    const lease = new ReviewInvocationLease(() => {
      if (this.activeLease === lease) this.activeLease = null;
    });
    this.activeLease = lease;
    return lease;
  }

  private async complete(
    lease: ReviewInvocationLease,
    ctx: Context,
    invocation: () => Promise<Status>,
    onSuccess?: (status: Status) => void,
  ): Promise<Status> {
    try {
      const status = await invocation();
      onSuccess?.(status);
      return status;
    } catch (error) {
      return this.lifecycle.failed(ctx, error);
    } finally {
      lease.release();
      this.lifecycle.completed(ctx);
    }
  }
}
