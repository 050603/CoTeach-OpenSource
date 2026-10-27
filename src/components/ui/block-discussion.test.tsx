import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';

import { BlockDiscussion } from './block-discussion';

describe('BlockDiscussion Plate wrapper contract', () => {
  it('returns a hook-free wrapper that creates a React component element', () => {
    const wrapNode = BlockDiscussion({} as never);

    expect(wrapNode).toBeTypeOf('function');
    expect(isValidElement(wrapNode!({ children: <span>正文</span> } as never))).toBe(true);
  });
});
