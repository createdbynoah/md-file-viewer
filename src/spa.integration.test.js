import { describe, it, expect } from 'vitest';
import { call } from './test-utils/app.js';

describe('SPA fallback', () => {
  it('serves index for a 25-char base36 id', async () => {
    const res = await call('/djmlk8rqmyfbvw0cfe0lkllww');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('index for /');
  });

  it('serves index for a legacy uuid', async () => {
    const res = await call('/123e4567-e89b-12d3-a456-426614174000');
    expect(res.status).toBe(200);
  });

  it('404s a base36 string that overflows 128 bits', async () => {
    expect((await call('/zzzzzzzzzzzzzzzzzzzzzzzzz')).status).toBe(404);
  });

  it('404s other paths', async () => {
    expect((await call('/about')).status).toBe(404);
    expect((await call('/djmlk8rqmyfbvw0cfe0lkllw')).status).toBe(404);
    expect((await call('/djmlk8rqmyfbvw0cfe0lkllww/x')).status).toBe(404);
  });
});
