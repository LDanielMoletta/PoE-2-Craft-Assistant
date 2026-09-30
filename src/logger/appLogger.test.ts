import { describe, it, expect, vi } from 'vitest';

import {
  sanitizeFields,
  redactText,
  createMemorySink,
  createConsoleSink,
  createLogger,
  formatLogLine,
  describeError,
  type LogFields,
  type LogRecord,
} from './appLogger.js';

const baseContext = {
  app: 'test',
  version: '1.0.0',
  platform: 'test',
  arch: 'x64',
  scope: 'test',
} as const;

const consoleMock = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('appLogger', () => {
  describe('sanitizeFields', () => {
    it('truncates long string values', () => {
      const fields: LogFields = { key: 'a'.repeat(2500) };
      const sanitized = sanitizeFields(fields, 100);
      expect(sanitized?.key).toHaveLength(100);
    });

    it('redacts secret keys case-insensitively', () => {
      const fields: LogFields = {
        normal: 'value',
        webhook: 'https://secret.com/hook',
        API_KEY: 'secret',
        password123: 'hidden',
      };
      const sanitized = sanitizeFields(fields);
      expect(sanitized?.normal).toBe('value');
      expect(sanitized?.webhook).toBe('[redacted]');
      expect(sanitized?.API_KEY).toBe('[redacted]');
      expect(sanitized?.password123).toBe('[redacted]');
    });

    it('handles nested objects by stringifying', () => {
      const fields: LogFields = { obj: { nested: 'value' } };
      const sanitized = sanitizeFields(fields);
      expect(typeof sanitized?.obj).toBe('string');
      expect(sanitized?.obj).toContain('nested');
    });

    it('handles undefined fields', () => {
      expect(sanitizeFields(undefined)).toBeUndefined();
    });

    it('handles null values in fields', () => {
      const fields: LogFields = { key: null as unknown as string };
      const sanitized = sanitizeFields(fields);
      expect(sanitized?.key).toBe('null');
    });
  });

  describe('redactText', () => {
    it('replaces secret tokens in text', () => {
      const text = 'token=abc123 webhook=https://hook.com key=secret';
      expect(redactText(text, ['abc123', 'secret'])).toContain('[redacted]');
      expect(redactText(text, ['abc123', 'secret'])).not.toContain('abc123');
      expect(redactText(text, ['abc123', 'secret'])).not.toContain('secret');
    });

    it('escapes regex special characters in secrets', () => {
      const text = 'value=a.b*c';
      const result = redactText(text, ['a.b*c']);
      expect(result).toBe('value=[redacted]');
    });

    it('handles empty secrets array', () => {
      expect(redactText('hello world', [])).toBe('hello world');
    });

    it('handles undefined secrets', () => {
      expect(redactText('hello world')).toBe('hello world');
    });
  });

  describe('createMemorySink', () => {
    it('stores entries up to capacity', () => {
      const sink = createMemorySink(3);
      sink.write({ time: '1', level: 'info', scope: 'test', message: 'a', context: baseContext } as LogRecord);
      sink.write({ time: '2', level: 'info', scope: 'test', message: 'b', context: baseContext } as LogRecord);
      sink.write({ time: '3', level: 'info', scope: 'test', message: 'c', context: baseContext } as LogRecord);
      sink.write({ time: '4', level: 'info', scope: 'test', message: 'd', context: baseContext } as LogRecord);

      const entries = sink.entries();
      expect(entries.length).toBeGreaterThanOrEqual(3);
    });

    it('returns readonly copy', () => {
      const sink = createMemorySink(2);
      sink.write({ time: '1', level: 'info', scope: 'test', message: 'a', context: baseContext } as LogRecord);
      const entries = sink.entries();
      expect(() => {
        (entries as LogRecord[]).push({ time: 'x', level: 'info', scope: 'test', message: 'x', context: baseContext } as LogRecord);
      }).toThrow();
    });
  });

  describe('createConsoleSink', () => {
    it('does not throw', () => {
      const sink = createConsoleSink(consoleMock);
      expect(() => {
        sink.write({ time: '1', level: 'info', scope: 'test', message: 'hello', context: baseContext } as LogRecord);
      }).not.toThrow();
    });
  });

  describe('createLogger', () => {
    it('respects minLevel', () => {
      const sink = createMemorySink(10);
      const logger = createLogger({
        context: baseContext,
        sinks: [sink],
        minLevel: 'warn',
      });

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      const entries = sink.entries();
      expect(entries.length).toBe(2);
    });

    it('includes fields and stack in record', () => {
      const sink = createMemorySink(10);
      const logger = createLogger({
        context: baseContext,
        sinks: [sink],
        minLevel: 'debug',
      });

      logger.info('with fields', { key: 'value' } as LogFields);
      logger.error('with stack', new Error('boom\n    at test.js:1'));

      const entries = sink.entries();
      expect(entries.length).toBe(2);
      const first = entries.at(0);
      const second = entries.at(1);
      if (first) expect(first.fields).toEqual({ key: 'value' });
      if (second) expect(second.stack).toContain('Error: boom');
    });

    it('memory sink keeps recent entries', () => {
      const logger = createLogger({
        context: baseContext,
        minLevel: 'debug',
      });

      for (let i = 0; i < 250; i++) {
        logger.info(`msg ${i}`);
      }

      const recent = logger.recent(5);
      expect(recent.length).toBe(5);
      expect(recent.at(0)?.message).toBe('msg 245');
    });

    it('recent returns empty when no entries', () => {
      const logger = createLogger({
        context: baseContext,
        minLevel: 'debug',
      });
      expect(logger.recent(10)).toHaveLength(0);
    });
  });

  describe('formatLogLine', () => {
    it('formats record without fields', () => {
      const record: LogRecord = {
        time: '2024-01-01T00:00:00.000Z',
        level: 'info',
        scope: 'test',
        message: 'hello',
        context: baseContext,
      };
      const line = formatLogLine(record);
      expect(line).toContain('2024-01-01T00:00:00.000Z');
      expect(line).toContain('INFO');
      expect(line).toContain('test');
      expect(line).toContain('hello');
      expect(line).not.toContain('fields');
    });

    it('formats record with fields', () => {
      const record: LogRecord = {
        time: '2024-01-01T00:00:00.000Z',
        level: 'error',
        scope: 'test',
        message: 'failed',
        context: baseContext,
        fields: { key: 'value' },
      };
      const line = formatLogLine(record);
      expect(line).toContain('ERROR');
      expect(line).toContain('{"key":"value"}');
    });

    it('formats record with stack', () => {
      const record: LogRecord = {
        time: '2024-01-01T00:00:00.000Z',
        level: 'error',
        scope: 'test',
        message: 'failed',
        context: baseContext,
        stack: 'Error: boom\n    at test.js:1',
      };
      const line = formatLogLine(record);
      expect(line).toContain('Error: boom');
    });
  });

  describe('describeError', () => {
    it('extracts message and stack from Error', () => {
      const error = new Error('boom');
      error.stack = 'Error: boom\n    at test.js:1';
      const desc = describeError(error);
      expect(desc.message).toBe('boom');
      expect(desc.stack).toBe('Error: boom\n    at test.js:1');
    });

    it('handles non-Error thrown values', () => {
      expect(describeError('string error').message).toBe('string error');
      expect(describeError(null).message).toBe('null');
      expect(describeError(123).message).toBe('123');
      expect(describeError({ foo: 'bar' }).message).toBe('[object Object]');
    });
  });
});