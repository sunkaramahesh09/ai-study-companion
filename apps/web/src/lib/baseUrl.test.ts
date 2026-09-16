import { describe, expect, it, vi } from 'vitest';
import { normalizeBaseUrl } from './baseUrl.ts';

describe('normalizeBaseUrl', () => {
  it('leaves a well-formed https URL alone', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });

  it('keeps http for local development', () => {
    expect(normalizeBaseUrl('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('returns empty for unset, so same-origin deploys still work', () => {
    expect(normalizeBaseUrl(undefined)).toBe('');
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });

  it('adds https when the scheme is missing', () => {
    // The real production bug: a bare hostname is treated by fetch() as a
    // relative path, so the request goes to the frontend origin, hits the SPA
    // rewrite and returns index.html with HTTP 200 — no error anywhere.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeBaseUrl('ai-study-companion-production-a07f.up.railway.app')).toBe(
      'https://ai-study-companion-production-a07f.up.railway.app',
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('strips trailing slashes so paths do not double up', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
  });

  it('leaves a protocol-relative URL alone', () => {
    expect(normalizeBaseUrl('//api.example.com')).toBe('//api.example.com');
  });
});
