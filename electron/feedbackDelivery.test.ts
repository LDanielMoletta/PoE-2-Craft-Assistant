import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const testDir = join(tmpdir(), `poe2-fb-test-${Date.now()}`);

let mod: {
  deliverFeedback: (payload: any, deps: any) => Promise<any>;
  sanitizeWebhookUrl: (url: string) => string | null;
  buildIssueUrl: (repo: string, payload: any) => string | null;
  feedbackFileName: (payload: any) => string;
  WEBHOOK_TIMEOUT_MS: number;
};

beforeEach(async () => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn());
  mod = await import('../electron/feedbackDelivery.cjs');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('feedbackDelivery', () => {
  const basePayload = {
    kind: 'bug' as const,
    title: '[Bug] Test',
    description: 'Test description',
    contact: 'user#1234',
    attachDiagnostics: true,
    diagnostics: {
      appVersion: '0.2.0',
      platform: 'win32',
      arch: 'x64',
      electron: '44.4.5',
      dataState: 'ready',
      league: 'Standard',
    },
    itemText: 'Rarity: Rare\n...',
    logText: '2024-01-01T00:00:00.000Z INFO ...',
    body: 'Test description\n\n---\n\n| |\n|---|\n| Versão | 0.2.0 |\n',
  };

  describe('sanitizeWebhookUrl', () => {
    it('returns null for null input', () => {
      expect(mod.sanitizeWebhookUrl(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(mod.sanitizeWebhookUrl('')).toBeNull();
    });

    it('returns null for http (not https)', () => {
      expect(mod.sanitizeWebhookUrl('http://example.com/hook')).toBeNull();
    });

    it('returns normalized https URL', () => {
      expect(mod.sanitizeWebhookUrl('https://example.com/hook')).toBe('https://example.com/hook');
    });

    it('returns null for invalid URL', () => {
      expect(mod.sanitizeWebhookUrl('not-a-url')).toBeNull();
    });

    it('returns null for javascript: scheme', () => {
      expect(mod.sanitizeWebhookUrl('javascript:alert(1)')).toBeNull();
    });

    it('returns null for data: scheme', () => {
      expect(mod.sanitizeWebhookUrl('data:text/html,test')).toBeNull();
    });
  });

  describe('buildIssueUrl', () => {
    it('builds valid github issue url', () => {
      const url = mod.buildIssueUrl('owner/repo', basePayload);
      expect(url).toContain('https://github.com/owner/repo/issues/new?');
      expect(url).toContain('title=');
      expect(url).toContain('body=');
    });

    it('returns null for invalid repo', () => {
      expect(mod.buildIssueUrl('', basePayload)).toBeNull();
      expect(mod.buildIssueUrl('owner', basePayload)).toBeNull();
      expect(mod.buildIssueUrl('owner/repo/', basePayload)).toBeNull();
    });
  });

  describe('feedbackFileName', () => {
    it('generates timestamped filename with kind', () => {
      const name = mod.feedbackFileName(basePayload);
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-bug\.md$/);
    });

    it('uses kind from payload', () => {
      const name = mod.feedbackFileName({ ...basePayload, kind: 'idea' });
      expect(name).toContain('-idea.md');
    });
  });

  describe('deliverFeedback', () => {
    const deps = {
      openExternal: vi.fn(),
      userDataPath: () => testDir,
      fetchImpl: vi.fn(),
    };

    it('rejects invalid payload', async () => {
      const result = await mod.deliverFeedback(null, deps);
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('none');
    });

    it('rejects empty description', async () => {
      const result = await mod.deliverFeedback({ ...basePayload, description: '' }, deps);
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('none');
    });

    it('rejects payload over 512KB', async () => {
      const bigPayload = { ...basePayload, description: 'x'.repeat(600 * 1024) };
      const result = await mod.deliverFeedback(bigPayload, deps);
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('none');
    });

    it('uses webhook when configured and succeeds', async () => {
      vi.stubEnv('POE2_FEEDBACK_WEBHOOK_URL', 'https://example.com/webhook');
      deps.fetchImpl = vi.fn().mockResolvedValue({ ok: true });

      const result = await mod.deliverFeedback(basePayload, deps);
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('webhook');
      expect(deps.fetchImpl).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('falls back to file when webhook fails', async () => {
      vi.stubEnv('POE2_FEEDBACK_WEBHOOK_URL', 'https://example.com/webhook');
      deps.fetchImpl = vi.fn().mockRejectedValue(new Error('network error'));

      const result = await mod.deliverFeedback(basePayload, deps);
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('file');
      expect(result.path).toContain(testDir);
      expect(result.webhookReason).toBe('network error');
    });

    it('falls back to file when webhook times out', async () => {
      vi.stubEnv('POE2_FEEDBACK_WEBHOOK_URL', 'https://example.com/webhook');
      deps.fetchImpl = vi.fn().mockImplementation(() => new Promise((_, reject) => {
        const err = new Error('timeout');
        err.name = 'AbortError';
        reject(err);
      }));

      const result = await mod.deliverFeedback(basePayload, deps);
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('file');
      expect(result.webhookReason).toBe('webhook expirou');
    });

    it('uses issue-url when no webhook but repo configured', async () => {
      vi.stubEnv('POE2_ISSUES_REPO', 'owner/repo');
      deps.openExternal = vi.fn().mockResolvedValue(undefined);

      const result = await mod.deliverFeedback(basePayload, deps);
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('issue-url');
      expect(result.url).toContain('github.com/owner/repo/issues/new');
      expect(deps.openExternal).toHaveBeenCalled();
    });

    it('writes to file when no webhook and no repo', async () => {
      deps.openExternal = vi.fn().mockResolvedValue(undefined);

      const result = await mod.deliverFeedback(basePayload, deps);
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('file');
      expect(result.path).toContain(testDir);

      // Verify file content
      const content = readFileSync(result.path, 'utf8');
      expect(content).toContain('Test description');
    });

    it('returns none when all destinations fail', async () => {
      // Make write fail by passing invalid path
      const badDeps = { ...deps, userDataPath: () => '/invalid/path/that/does/not/exist' };
      const result = await mod.deliverFeedback(basePayload, badDeps);
      expect(result.ok).toBe(false);
      expect(result.channel).toBe('file'); // file channel but ok: false
    });
  });
});