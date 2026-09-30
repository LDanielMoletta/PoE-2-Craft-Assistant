'use strict';

const { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } = require('node:fs');
const path = require('node:path');

/**
 * Escrita do log em arquivo, no processo main.
 *
 * Fica em modulo separado porque e' codigo com efeito colateral no disco
 * (cria diretorio, rotaciona, apaga) e precisa poder ser testado e lido sem
 * passar pelo `app`. O renderer nao escreve nada: ele manda a linha pelo IPC e o
 * main decide o que fazer com ela.
 *
 * Por que append e nao "grava e renomeia" como o `config.json`: um log e'
 * append-only por natureza e perde-se no maximo a ultima linha num crash, o
 * que e' aceitavel. Reescrever o arquivo inteiro a cada registro transformaria
 * todo log em operacao de leitura-modificacao-escrita, com janela de corrupcao
 * bem maior. `appendFileSync` abre com FILE_APPEND_DATA, entao escritas
 * concorrentes nao se intercalam no meio de uma linha.
 *
 * A rotacao e por tamanho e rename: `app.log` vira `app.log.1` e o anterior vai
 * para `.2`. Um jogador que joga todo dia nao deve acumular log infinito em
 * `%APPDATA%`, e `.gz` nao compensa aqui porque o arquivo e' texto puro de
 * poucos MB e o antivirus do Windows desconfia deCompactacao.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROTATIONS = 2;

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch (thrown) {
    if (thrown && thrown.code === 'ENOENT') return;
    throw thrown;
  }
  if (size < MAX_BYTES) return;

  for (let index = MAX_ROTATIONS; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${String(index - 1)}`;
    const to = `${file}.${String(index)}`;
    try {
      renameSync(from, to);
    } catch (thrown) {
      if (thrown && thrown.code === 'ENOENT') continue;
      throw thrown;
    }
  }
  try {
    unlinkSync(`${file}.${String(MAX_ROTATIONS)}`);
  } catch (thrown) {
    if (!thrown || thrown.code !== 'ENOENT') throw thrown;
  }
}

/**
 * Cria o escritor. `path` pode ser sobreposto nos testes; por default vai para
 * `app.getPath('logs')`, que no Windows e' `%APPDATA%\<nome>\logs` — um lugar
 * que o usuario encontra e que o instalador NSIS remove junto com o app.
 */
function createLogFile(filePath) {
  const dir = path.dirname(filePath);
  let broken = false;
  const problems = [];

  const write = (line) => {
    if (broken || typeof line !== 'string' || line === '') return;
    try {
      ensureDir(dir);
      rotateIfNeeded(filePath);
      // Uma linha por registro: sem isso o grep do usuario precisaria lidar com
      // entradas multilinha.
      appendFileSync(filePath, `${line.replace(/\s*\n\s*/g, ' | ')}\n`, 'utf8');
    } catch (thrown) {
      // Disco cheio, pasta bloqueada por antivirus, path invalido: a partir
      // daqui o log vai so para o console. Desligar o escritor evita Thousands
      // de excecoes por quadro e mantem o diagnostico no stderr.
      broken = true;
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      problems.push(message);
      console.error(`[log] escrita em ${filePath} falhou, seguindo no console: ${message}`);
    }
  };

  return {
    path: filePath,
    write,
    isBroken: () => broken,
    problems: () => [...problems],
    /** Ultimas linhas, para o relatorio de feedback. */
    tail(limit) {
      try {
        const raw = readFileSync(filePath, 'utf8');
        return raw
          .split('\n')
          .filter((line) => line !== '')
          .slice(-limit)
          .join('\n');
      } catch {
        return '';
      }
    },
  };
}

/** Objeto unico: o main, o IPC e os tratadores globais escrevem no mesmo. */
let current = null;

function init(app) {
  current = createLogFile(path.join(app.getPath('logs'), 'app.log'));
  return current;
}

function get() {
  if (current === null) throw new Error('logFile nao inicializado: chame init(app) no whenReady');
  return current;
}

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Registro do processo main. Espelha `src/logger/appLogger.ts` na saida: um
 * evento por linha, campos como JSON quando vierem estruturados.
 */
function logMain(level, message, fields) {
  if (current === null) {
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    method(`[${level}] ${message}`);
    return;
  }

  const parts = [new Date().toISOString(), level.toUpperCase(), 'main', String(message)];
  if (fields !== undefined && fields !== null) parts.push(serialize(fields));
  current.write(parts.join(' '));
}

/**
 * Le o que o renderer mandou. O renderer ja manda JSON de uma linha entao a
 * validacao aqui e' so de forma: barra o que vier com quebras (tentativa de
 * injetar linhas falsas no arquivo) e o que nao for objeto.
 */
function logFromRenderer(line) {
  if (typeof line !== 'string' || line === '' || line.length > 64 * 1024) return;
  if (line.includes('\n') || line.includes('\r')) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    current?.write(line.replace(/[^\x20-\x7e]/g, '?'));
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;

  const level = typeof parsed.level === 'string' && LEVEL_ORDER[parsed.level] ? parsed.level : 'info';
  const scope = typeof parsed.scope === 'string' ? parsed.scope.slice(0, 40) : 'renderer';
  const message = typeof parsed.message === 'string' ? parsed.message : '(sem mensagem)';
  const parts = [`${parsed.time ?? new Date().toISOString()}`, level.toUpperCase(), scope, message];
  if (parsed.fields !== undefined) parts.push(serialize(parsed.fields));
  if (typeof parsed.stack === 'string') parts.push(parsed.stack);
  current?.write(parts.join(' '));
}

module.exports = {
  createLogFile,
  init,
  logMain,
  logFromRenderer,
  get,
  MAX_BYTES,
  MAX_ROTATIONS,
};
