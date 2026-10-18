export interface EventSourceLeaseRequest {
  readonly key: string;
  readonly ownerId: string;
  readonly now: Date;
  readonly leaseMs: number;
}

export interface EventSourceLeases {
  /** Takes or renews the lease; false while another owner holds an unexpired one. */
  claim(request: EventSourceLeaseRequest): Promise<boolean>;
  release(p: { readonly key: string; readonly ownerId: string }): Promise<void>;
}
