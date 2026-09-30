import { describe, it, expect } from 'vitest';

import {
  buildTitle,
  buildBody,
  buildFeedbackPayload,
  selectDelivery,
  isValidContact,
  buildIssueUrl,
  describeDelivery,
  type FeedbackDiagnostics,
  type FeedbackDraft,
} from './feedbackReport.js';

const baseDiagnostics: FeedbackDiagnostics = {
  appVersion: '0.2.0',
  platform: 'win32',
  arch: 'x64',
  electron: '44.4.5',
  dataState: 'ready',
  league: 'Standard',
};

function makeDraft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    kind: 'bug',
    description: 'O overlay nao abre ao pressionar o atalho.',
    attachDiagnostics: true,
    contact: 'user#1234',
    itemText: 'Rarity: Rare\nChest Armour\n...',
    logText: '2024-01-01T00:00:00.000Z INFO renderer ...\n2024-01-01T00:00:01.000Z ERROR renderer ...',
    ...overrides,
  };
}

describe('feedbackReport', () => {
  describe('isValidContact', () => {
    it('accepts empty string', () => {
      expect(isValidContact('')).toBe(true);
    });

    it('accepts Discord tag', () => {
      expect(isValidContact('user#1234')).toBe(true);
    });

    it('accepts email', () => {
      expect(isValidContact('user@example.com')).toBe(true);
    });

    it('accepts plain username', () => {
      expect(isValidContact('username')).toBe(true);
    });

    it('rejects spaces', () => {
      expect(isValidContact('user name')).toBe(false);
    });

    it('rejects URL characters', () => {
      expect(isValidContact('http://example.com')).toBe(false);
    });

    it('rejects markdown link characters', () => {
      expect(isValidContact('[link](url)')).toBe(false);
    });

    it('rejects over 120 chars', () => {
      expect(isValidContact('a'.repeat(121))).toBe(false);
    });

    it('accepts exactly 120 chars', () => {
      expect(isValidContact('a'.repeat(120))).toBe(true);
    });
  });

  describe('buildTitle', () => {
    it('prefixes bug with [Bug]', () => {
      const draft = makeDraft({ description: 'Crash ao abrir' });
      expect(buildTitle(draft)).toBe('[Bug] Crash ao abrir');
    });

    it('prefixes idea with [Ideia]', () => {
      const draft = makeDraft({ kind: 'idea', description: 'Adicionar tema escuro' });
      expect(buildTitle(draft)).toBe('[Ideia] Adicionar tema escuro');
    });

    it('truncates at 80 chars', () => {
      const longDesc = 'a'.repeat(100);
      const draft = makeDraft({ description: longDesc });
      expect(buildTitle(draft).length).toBeLessThanOrEqual(85);
    });

    it('strips markdown chars', () => {
      const draft = makeDraft({ description: '# *Crash* `code`' });
      expect(buildTitle(draft)).not.toMatch(/[#*`]/);
    });

    it('uses only prefix when description is whitespace', () => {
      const draft = makeDraft({ description: '   \n  \n' });
      expect(buildTitle(draft)).toBe('[Bug]');
    });
  });

  describe('buildBody', () => {
    it('includes description', () => {
      const body = buildBody(makeDraft(), baseDiagnostics);
      expect(body).toContain('O overlay nao abre ao pressionar o atalho.');
    });

    it('includes diagnostics table', () => {
      const body = buildBody(makeDraft(), baseDiagnostics);
      expect(body).toContain('| Versão | 0.2.0 |');
      expect(body).toContain('| Plataforma | win32 (x64) |');
      expect(body).toContain('| Electron | 44.4.5 |');
      expect(body).toContain('| Base de dados | ready |');
      expect(body).toContain('| League | Standard |');
      expect(body).toContain('| Contato | user#1234 |');
    });

    it('includes item and logs in details when attachDiagnostics', () => {
      const body = buildBody(makeDraft(), baseDiagnostics);
      expect(body).toContain('### Texto do último item');
      expect(body).toContain('Rarity: Rare');
      expect(body).toContain('### Logs');
      expect(body).toContain('2024-01-01T00:00:00.000Z INFO renderer');
    });

    it('omits details when attachDiagnostics is false', () => {
      const draft = makeDraft({ attachDiagnostics: false });
      const body = buildBody(draft, baseDiagnostics);
      expect(body).not.toContain('### Texto do último item');
      expect(body).not.toContain('### Logs');
      expect(body).toContain('Sem anexos');
    });

    it('omits item/logs when they are empty', () => {
      const draft = makeDraft({ itemText: '', logText: '' });
      const body = buildBody(draft, baseDiagnostics);
      expect(body).not.toContain('### Texto do último item');
      expect(body).not.toContain('### Logs');
    });

    it('omits optional diagnostics fields when null', () => {
      const diag = { ...baseDiagnostics, electron: undefined, dataState: null, league: null };
      const body = buildBody(makeDraft(), diag);
      expect(body).not.toContain('| Electron |');
      expect(body).not.toContain('| Base de dados |');
      expect(body).not.toContain('| League |');
    });

    it('omits contact when empty', () => {
      const draft = makeDraft({ contact: '' });
      const body = buildBody(draft, baseDiagnostics);
      expect(body).not.toContain('| Contato |');
    });
  });

  describe('buildFeedbackPayload', () => {
    it('truncates description to MAX_DESCRIPTION', () => {
      const longDesc = 'a'.repeat(5000);
      const draft = makeDraft({ description: longDesc });
      const payload = buildFeedbackPayload(draft, baseDiagnostics);
      expect(payload.description.length).toBe(4000);
    });

    it('normalizes contact to null when empty', () => {
      const draft = makeDraft({ contact: '  ' });
      const payload = buildFeedbackPayload(draft, baseDiagnostics);
      expect(payload.contact).toBeNull();
    });

    it('drops itemText/logText when attachDiagnostics false', () => {
      const draft = makeDraft({ attachDiagnostics: false });
      const payload = buildFeedbackPayload(draft, baseDiagnostics);
      expect(payload.itemText).toBeUndefined();
      expect(payload.logText).toBeUndefined();
    });

    it('keeps itemText/logText when attachDiagnostics true', () => {
      const payload = buildFeedbackPayload(makeDraft(), baseDiagnostics);
      expect(payload.itemText).toBe('Rarity: Rare\nChest Armour\n...');
      expect(payload.logText).toContain('2024-01-01T00:00:00.000Z INFO renderer');
    });

    it('includes title and body', () => {
      const payload = buildFeedbackPayload(makeDraft(), baseDiagnostics);
      expect(payload.title).toContain('[Bug]');
      expect(payload.body).toContain('O overlay nao abre');
    });
  });

  describe('buildIssueUrl', () => {
    it('builds valid github issue url', () => {
      const payload = buildFeedbackPayload(makeDraft(), baseDiagnostics);
      const url = buildIssueUrl('owner/repo', payload);
      expect(url).toContain('https://github.com/owner/repo/issues/new?');
      expect(url).toContain('title=');
      expect(url).toContain('body=');
    });

    it('returns null for invalid repo', () => {
      const payload = buildFeedbackPayload(makeDraft(), baseDiagnostics);
      expect(buildIssueUrl('', payload)).toBeNull();
      expect(buildIssueUrl('owner', payload)).toBeNull();
      expect(buildIssueUrl('owner/repo/', payload)).toBeNull();
    });

    it('allows custom baseUrl', () => {
      const payload = buildFeedbackPayload(makeDraft(), baseDiagnostics);
      const url = buildIssueUrl('owner/repo', payload, 'https://github.example.com');
      expect(url?.startsWith('https://github.example.com/')).toBe(true);
    });
  });

  describe('selectDelivery', () => {
    const basePayload = buildFeedbackPayload(makeDraft(), baseDiagnostics);

    it('prefers webhook when set', () => {
      const result = selectDelivery({
        webhookUrl: 'https://example.com/webhook',
        issueRepo: 'owner/repo',
        fallbackPath: '/tmp/fb.md',
        payload: basePayload,
      });
      expect(result).toEqual({ channel: 'webhook', ok: true });
    });

    it('falls back to issue-url when no webhook but repo set', () => {
      const result = selectDelivery({
        webhookUrl: null,
        issueRepo: 'owner/repo',
        fallbackPath: '/tmp/fb.md',
        payload: basePayload,
      });
      expect(result.channel).toBe('issue-url');
      expect(result.ok).toBe(true);
      if (result.ok && result.channel === 'issue-url') expect(result.url).toContain('github.com/owner/repo/issues/new');
    });

    it('falls back to file when no webhook and no repo', () => {
      const result = selectDelivery({
        webhookUrl: null,
        issueRepo: null,
        fallbackPath: '/tmp/fb.md',
        payload: basePayload,
      });
      expect(result.channel).toBe('file');
      expect(result.ok).toBe(true);
      if (result.ok && result.channel === 'file') expect(result.path).toBe('/tmp/fb.md');
    });

    it('returns none when no destination configured', () => {
      const result = selectDelivery({
        webhookUrl: null,
        issueRepo: null,
        fallbackPath: null,
        payload: basePayload,
      });
      expect(result.channel).toBe('none');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('Nenhum destino');
    });

    it('returns none for empty webhook', () => {
      const result = selectDelivery({
        webhookUrl: '',
        issueRepo: null,
        fallbackPath: null,
        payload: basePayload,
      });
      expect(result.channel).toBe('none');
    });
  });

  describe('describeDelivery', () => {
    it('describes webhook success', () => {
      expect(describeDelivery({ channel: 'webhook', ok: true })).toBe('Enviado. Obrigado pelo relato!');
    });

    it('describes issue-url success', () => {
      expect(describeDelivery({ channel: 'issue-url', ok: true, url: 'https://github.com/owner/repo/issues/new?...' }))
        .toBe('Abri o navegador com a issue preenchida. Revise e confirme o envio.');
    });

    it('describes file success without webhook reason', () => {
      expect(describeDelivery({ channel: 'file', ok: true, path: '/tmp/foo.md' }))
        .toBe('Salvo em /tmp/foo.md. Nenhum destino online configurado.');
    });

    it('describes file success with webhook reason', () => {
      expect(describeDelivery({ channel: 'file', ok: true, path: '/tmp/foo.md', webhookReason: 'webhook expirou' }))
        .toBe('Webhook indisponível (webhook expirou). Salvei em /tmp/foo.md.');
    });

    it('describes webhook failure', () => {
      expect(describeDelivery({ channel: 'webhook', ok: false, reason: 'timeout' }))
        .toBe('Não foi possível enviar: timeout');
    });

    it('describes file failure', () => {
      expect(describeDelivery({ channel: 'file', ok: false, reason: 'permission denied' }))
        .toBe('Não foi possível enviar: permission denied');
    });

    it('describes none', () => {
      expect(describeDelivery({ channel: 'none', ok: false, reason: 'no config' }))
        .toBe('Não foi possível enviar: no config');
    });
  });
});