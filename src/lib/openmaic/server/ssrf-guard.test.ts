import { describe, expect, it } from 'vitest';
import { isPrivateIP } from './ssrf-guard';

describe('isPrivateIP ISATAP handling', () => {
  it.each([
    '2001:4860:0:1:0:5efe:7f00:1',
    '2001:4860:0:1:200:5efe:a00:1',
    '2001:4860:0:1::5efe:c0a8:101',
    '2001:4860:0:1::5efe:192.168.1.1',
  ])('blocks a private IPv4 endpoint embedded in %s', (address) => {
    expect(isPrivateIP(address)).toBe(true);
  });

  it.each([
    '2001:4860:0:1::5efe:8.8.8.8',
    '2001:4860::100:5efe:127.0.0.1',
    '2001:4860::300:5efe:127.0.0.1',
    '2001:4860:0:1:0:beef:127.0.0.1',
    '2001:4860:0:1:0:5efe::127.0.0.1',
  ])('does not misclassify the public or malformed lookalike %s', (address) => {
    expect(isPrivateIP(address)).toBe(false);
  });
});
