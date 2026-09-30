/**
 * Relatorio de feedback: o que o modal monta e o main envia.
 *
 * Fica separado do componente React por dois motivos: o texto que vai para o
 * webhook e o corpo da issue precisam ser montados uma vez so (a UI mostra uma
 * previa, o main envia o mesmo texto), e o formato tem regra de privacy que
 * merece teste proprio.
 *
 * Regra de privacy, aplicada aqui e nao no componente: **o texto do item e os
 * logs so saem da maquina se o jogador marcar a caixa**. Sem a caixa, o
 * relatorio leva a descricao, a versao e nada mais. O default e' desmarcado
 * porque o texto de um item copiado do jogo pode conter o nome do personagem.
 */

export type FeedbackKind = 'bug' | 'idea';

export interface FeedbackDraft {
  readonly kind: FeedbackKind;
  readonly description: string;
  /** Marcado = o texto do ultimo item e os logs recentes vao junto. */
  readonly attachDiagnostics: boolean;
  /** Texto do ultimo item analisado. Usado so se `attachDiagnostics`. */
  readonly itemText?: string;
  /** Log formatado, do mais antigo para o mais novo. */
  readonly logText?: string;
  readonly contact?: string | null;
}

export interface FeedbackDiagnostics {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly electron?: string | undefined;
  /** Estado da base no momento do envio; o jogador costuma culpar a base. */
  readonly dataState?: string | null;
  readonly league?: string | null;
}

export interface FeedbackPayload {
  readonly kind: FeedbackKind;
  readonly description: string;
  readonly contact: string | null;
  readonly attachDiagnostics: boolean;
  readonly diagnostics: FeedbackDiagnostics;
  /** Presente apenas com a caixa marcada. */
  readonly itemText?: string;
  readonly logText?: string;
  /** Markdown pronto para o corpo da issue. */
  readonly body: string;
  /** Titulo curto, derivado da descricao. */
  readonly title: string;
}

export const FEEDBACK_KINDS: Readonly<Record<FeedbackKind, string>> = {
  bug: 'Bug',
  idea: 'Sugestão',
};

export const MAX_DESCRIPTION = 4000;

/** `owner/repo`; sem isso nao ha link de issue para montar. */
const ISSUES_URL_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function isValidContact(contact: string): boolean {
  const trimmed = contact.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 120) return false;
  // Discord tag, e-mail ou usuario solto. Barrar `@`ilo de espacos e
  // caracteres de URL e' o suficiente: o campo vai para um markdown, e um
  // `[texto](javascript:...)` la viraria link clicavel na issue.
  if (/[\s<>[\]()]/.test(trimmed)) return false;
  return /^[@A-Za-z0-9._+-]+$/.test(trimmed);
}

export function buildTitle(draft: FeedbackDraft): string {
  const firstLine = draft.description
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const summary = (firstLine ?? '').slice(0, 80).replace(/[#*`]/g, '');
  const prefix = draft.kind === 'bug' ? '[Bug]' : '[Ideia]';
  return summary === '' ? prefix : `${prefix} ${summary}`;
}

/**
 * Corpo em markdown. O texto do item vai em `<details>` para nao lotar a issue:
 * ele e' longo, e so interessa a quem for reproduzir.
 */
export function buildBody(draft: FeedbackDraft, diagnostics: FeedbackDiagnostics): string {
  const lines: string[] = [];
  lines.push(draft.description.trim());
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Versão | ${diagnostics.appVersion} |`);
  lines.push(`| Plataforma | ${diagnostics.platform} (${diagnostics.arch}) |`);
  if (diagnostics.electron !== undefined) lines.push(`| Electron | ${diagnostics.electron} |`);
  if (diagnostics.dataState !== null && diagnostics.dataState !== undefined) {
    lines.push(`| Base de dados | ${diagnostics.dataState} |`);
  }
  if (diagnostics.league !== null && diagnostics.league !== undefined) {
    lines.push(`| League | ${diagnostics.league} |`);
  }
  if (draft.contact !== null && draft.contact !== undefined && draft.contact.trim() !== '') {
    lines.push(`| Contato | ${draft.contact.trim()} |`);
  }

  if (draft.attachDiagnostics) {
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>Diagnóstico anexado pelo autor</summary>');
    lines.push('');
    if (draft.itemText !== null && draft.itemText !== undefined && draft.itemText !== '') {
      lines.push('### Texto do último item');
      lines.push('');
      lines.push('```');
      lines.push(draft.itemText);
      lines.push('```');
      lines.push('');
    }
    if (draft.logText !== null && draft.logText !== undefined && draft.logText !== '') {
      lines.push('### Logs');
      lines.push('');
      lines.push('```');
      lines.push(draft.logText);
      lines.push('```');
    }
    lines.push('');
    lines.push('</details>');
  }

  return lines.join('\n');
}

/** Descarta o que nao foi preenchido e normaliza os limites de tamanho. */
export function buildFeedbackPayload(
  draft: FeedbackDraft,
  diagnostics: FeedbackDiagnostics,
): FeedbackPayload {
  const description = draft.description.trim().slice(0, MAX_DESCRIPTION);
  const contact = draft.contact === undefined || draft.contact === null ? null : draft.contact.trim();
  const normalized: FeedbackDraft = {
    kind: draft.kind,
    description,
    attachDiagnostics: draft.attachDiagnostics,
    contact: contact === '' ? null : contact,
    ...(draft.attachDiagnostics && draft.itemText != null ? { itemText: draft.itemText } : {}),
    ...(draft.attachDiagnostics && draft.logText != null ? { logText: draft.logText } : {}),
  };

  return {
    kind: normalized.kind,
    description: normalized.description,
    contact: normalized.contact ?? null,
    attachDiagnostics: normalized.attachDiagnostics,
    diagnostics,
    ...(normalized.itemText === undefined ? {} : { itemText: normalized.itemText }),
    ...(normalized.logText === undefined ? {} : { logText: normalized.logText }),
    title: buildTitle(normalized),
    body: buildBody(normalized, diagnostics),
  };
}

/**
 * URL da issue pre-preenchida. So https: um `javascript:` ou um `http://`
 * apontando para uma maquina controlada por terceiros entraria pelo
 * `openExternal` do Electron.
 */
export function buildIssueUrl(
  repo: string,
  payload: FeedbackPayload,
  baseUrl = 'https://github.com',
): string | null {
  if (!ISSUES_URL_RE.test(repo)) return null;
  const params = new URLSearchParams({ title: payload.title, body: payload.body });
  return `${baseUrl}/${repo}/issues/new?${params.toString()}`;
}

/**
 * O que o modal devolve ao host.
 */
export interface FeedbackSubmission {
  readonly kind: FeedbackKind;
  readonly description: string;
  readonly attachDiagnostics: boolean;
  readonly contact: string | null;
}

/** Resposta do host apos tentar enviar. */
export type FeedbackResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resultado do envio, como devolvido por `electron/feedbackDelivery.cjs`.
 * O destino e' decidido no main, entao o renderer so traduz isto para texto.
 */
export type FeedbackDeliveryResult =
  | { readonly channel: 'webhook'; readonly ok: true }
  | { readonly channel: 'issue-url'; readonly ok: true; readonly url: string }
  | { readonly channel: 'file'; readonly ok: true; readonly path: string; readonly webhookReason?: string }
  | { readonly channel: 'webhook'; readonly ok: false; readonly reason: string }
  | { readonly channel: 'file'; readonly ok: false; readonly reason: string }
  | { readonly channel: 'none'; readonly ok: false; readonly reason: string };

/** Traduz o resultado em algo que o jogador consiga agir. */
export function describeDelivery(result: FeedbackDeliveryResult): string {
  if (!result.ok) return `Não foi possível enviar: ${result.reason}`;
  switch (result.channel) {
    case 'webhook':
      return 'Enviado. Obrigado pelo relato!';
    case 'issue-url':
      return 'Abri o navegador com a issue preenchida. Revise e confirme o envio.';
    case 'file':
      return result.webhookReason === undefined
        ? `Salvo em ${result.path}. Nenhum destino online configurado.`
        : `Webhook indisponível (${result.webhookReason}). Salvei em ${result.path}.`;
  }
}

/**
 * Escolhe por onde o relatorio sai. A ordem importa:
 *
 *  1. Webhook configurado: envio automatico.
 *  2. Issue URL: abre o navegador com tudo pre-preenchido. O jogador ve e
 *     decide o que enviar, o que e' o comportamento correto por padrao.
 *  3. Arquivo em disco: ultimo recurso, para quando nao ha repo nem webhook.
 */
export function selectDelivery(options: {
  readonly webhookUrl: string | null;
  readonly issueRepo: string | null;
  readonly fallbackPath: string | null;
  readonly payload: FeedbackPayload;
}): FeedbackDeliveryResult {
  if (options.webhookUrl !== null && options.webhookUrl !== '') {
    return { channel: 'webhook', ok: true };
  }
  if (options.issueRepo !== null && options.issueRepo !== '') {
    const url = buildIssueUrl(options.issueRepo, options.payload);
    if (url !== null) return { channel: 'issue-url', ok: true, url };
  }
  if (options.fallbackPath !== null) {
    return { channel: 'file', ok: true, path: options.fallbackPath };
  }
  return {
    channel: 'none',
    ok: false,
    reason: 'Nenhum destino configurado (POE2_FEEDBACK_WEBHOOK_URL ou POE2_ISSUES_REPO).',
  };
}
