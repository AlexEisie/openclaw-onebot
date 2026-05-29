import { describe, expect, it } from 'vitest';

import { BATCH_GAP_MS } from '../src/gateway';

describe('OneBot inbound message batching', () => {
  it('keeps the default debounce below the visible chat latency threshold', () => {
    expect(BATCH_GAP_MS).toBeLessThanOrEqual(300);
  });
});
