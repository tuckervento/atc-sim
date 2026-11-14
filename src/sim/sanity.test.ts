import { describe, expect, it } from 'vitest';

describe('scaffold', () => {
  it('runs sim tests without a DOM', () => {
    expect('document' in globalThis).toBe(false);
  });
});
