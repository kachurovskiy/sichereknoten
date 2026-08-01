export interface RequestToken {
  kind: string;
  id: number;
  detail: string | null;
}

export class RequestGate {
  private readonly latestIds = new Map<string, number>();

  start(kind: string, detail: string | null = null): RequestToken {
    const id = (this.latestIds.get(kind) ?? 0) + 1;
    this.latestIds.set(kind, id);
    return { kind, id, detail };
  }

  cancel(kind: string): void {
    this.latestIds.set(kind, (this.latestIds.get(kind) ?? 0) + 1);
  }

  isCurrent(token: RequestToken): boolean {
    return this.latestIds.get(token.kind) === token.id;
  }
}
