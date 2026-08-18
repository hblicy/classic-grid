export type RiseTransferRow = {
  amount: string;
  type: string;
  timestamp?: string;
  block_time?: string;
  transaction_hash?: string;
  id?: string;
  tx_hash?: string;
  [key: string]: unknown;
};

export class RiseExchange {
  constructor(options?: Record<string, unknown>);
  info: {
    http: {
      get(path: string): Promise<unknown>;
    };
  };
  getTransferHistory(limit?: number): Promise<RiseTransferRow[]>;
}
