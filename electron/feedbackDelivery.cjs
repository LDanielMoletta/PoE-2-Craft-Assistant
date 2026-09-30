'use strict';

const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

/**
 * Entrega do relatorio de feedback.
 *
 * Tres destinos, nesta ordem, e a escolha e' feita aqui e nao no renderer:
 *
 *  1. `POE2_FEEDBACK_WEBHOOK_URL` - envio automatico. So https, e so host que a
 *     aplicacao configurou: um webhook vindo do renderer permitiria trocar o
 *     destino e mandar o log do jogador para um servidor arbitrario.
 *  2. `POE2_ISSUES_REPO` - abre o navegador com a issue pre-preenchida. E' o
 *     default porque deixa o jogador ver e decidir o que enviar.
 *  3. Arquivo em `userData/feedback/`, para quando nao ha repo nem webhook e o
 *     jogador nao tem navegador aberto na hora.
 *
 * O `attachDiagnostics` ja foi resolvido no renderer: o payload chega aqui sem o
 * texto do item e sem os logs quando a caixa nao foi marcada. Este modulo nao
 * volta a anexar nada.
 */

const WEBHOOK_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512 * 1024;

function envOrNull(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * https e obrigatorio. `http://` mandaria o log em claro, e qualquer outro
 * esquema passaria a URL para o `fetch` do Node, que nao e' o que se quer
 * num campo de configuracao.
 */
function sanitizeWebhookUrl(raw) {
  if (raw === null) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return url.toString();
}

const ISSUES_URL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Mesmo formato de `src/feedback/feedbackReport.ts`, reimplementado em JS puro
 * porque este arquivo e carregado pelo main sem passar por build. As duas
 * implementacoes sao cobertas pelos mesmos casos no teste.
 */
function buildIssueUrl(repo, payload) {
  if (!ISSUES_URL_RE.test(repo)) return null;
  const params = new URLSearchParams({ title: payload.title, body: payload.body });
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

function feedbackFileName(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${payload.kind}.md`;
}

async function postWebhook(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: payload.kind,
        title: payload.title,
        description: payload.description,
        contact: payload.contact,
        attachDiagnostics: payload.attachDiagnostics,
        diagnostics: payload.diagnostics,
        ...(payload.itemText === undefined ? {} : { itemText: payload.itemText }),
        ...(payload.logText === undefined ? {} : { logText: payload.logText }),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, reason: `webhook respondeu ${response.status}` };
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param payload objeto ja normalizado por `buildFeedbackPayload`
 * @param deps injetado nos testes: `openExternal`, `userDataPath`, `fetch`
 */
async function deliverFeedback(payload, deps) {
  const openExternal = deps.openExternal;
  const userDataPath = deps.userDataPath();
  const doFetch = deps.fetchImpl ?? fetch;

  if (typeof payload !== 'object' || payload === null) {
    return { channel: 'none', ok: false, reason: 'payload invalido' };
  }
  if (typeof payload.description !== 'string' || payload.description.trim() === '') {
    return { channel: 'none', ok: false, reason: 'descricao vazia' };
  }

  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { channel: 'none', ok: false, reason: 'relatorio acima de 512 KB' };
  }

  const webhook = sanitizeWebhookUrl(envOrNull('POE2_FEEDBACK_WEBHOOK_URL'));
  if (webhook !== null) {
    try {
      const result = await postWebhook(webhook, payload);
      if (result.ok) return { channel: 'webhook', ok: true };
      // Webhook fora do ar nao pode ser o fim da historia: cai para o arquivo
      // local, que e' exatamente o caso em que o usuario mais precisa dele.
      const fallback = writeToDisk(payload, userDataPath);
      if (fallback.ok) return { ...fallback, webhookReason: result.reason };
      return { channel: 'webhook', ok: false, reason: result.reason };
    } catch (thrown) {
      const message = thrown && thrown.name === 'AbortError' ? 'webhook expirou' : String(thrown && thrown.message ? thrown.message : thrown);
      const fallback = writeToDisk(payload, userDataPath);
      if (fallback.ok) return { ...fallback, webhookReason: message };
      return { channel: 'webhook', ok: false, reason: message };
    }
  }

  const repo = envOrNull('POE2_ISSUES_REPO');
  if (repo !== null) {
    const url = buildIssueUrl(repo, payload);
    if (url !== null) {
      await openExternal(url);
      return { channel: 'issue-url', ok: true, url };
    }
  }

  const written = writeToDisk(payload, userDataPath);
  if (written.ok) return written;
  return { channel: 'none', ok: false, reason: 'sem webhook, sem repo e sem permissao de escrita' };
}

function writeToDisk(payload, userDataPath) {
  try {
    const dir = path.join(userDataPath, 'feedback');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, feedbackFileName(payload));
    writeFileSync(file, `${payload.body}\n`, 'utf8');
    return { channel: 'file', ok: true, path: file };
  } catch (thrown) {
    return { channel: 'file', ok: false, reason: String(thrown && thrown.message ? thrown.message : thrown) };
  }
}

module.exports = {
  deliverFeedback,
  sanitizeWebhookUrl,
  buildIssueUrl,
  feedbackFileName,
  WEBHOOK_TIMEOUT_MS,
};
