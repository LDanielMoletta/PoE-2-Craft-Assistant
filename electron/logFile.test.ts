import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), `poe2-log-test-${Date.now()}`);

let mod: {
  createLogFile: (path: string) => {
    write: (line: string) => void;
    tail: (limit: number) => string;
    path: string;
    isBroken: () => boolean;
    problems: () => string[];
  };
};

beforeEach(async () => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  vi.resetModules();
  mod = await import('../electron/logFile.cjs');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('logFile', () => {
  describe('createLogFile', () => {
    it('writes single line', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);
      log.write('2024-01-01T00:00:00.000Z INFO test message');

      const tail = log.tail(10);
      expect(tail).toBe('2024-01-01T00:00:00.000Z INFO test message');
    });

    it('writes multiple lines', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);
      log.write('line 1');
      log.write('line 2');
      log.write('line 3');

      const tail = log.tail(10);
      expect(tail.split('\n')).toHaveLength(3);
      expect(tail).toContain('line 1');
      expect(tail).toContain('line 3');
    });

    it('respects tail limit', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);
      for (let i = 0; i < 15; i++) log.write(`line ${i}`);

      const tail = log.tail(5);
      const lines = tail.split('\n');
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('line 10');
      expect(lines[4]).toBe('line 14');
    });

    it('replaces newlines in line with pipe', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);
      log.write('multi\nline\ntext');

      const tail = log.tail(1);
      expect(tail).toBe('multi | line | text');
    });

    it('ignores empty lines', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);
      log.write('');
      log.write('  ');
      log.write('real');

      const tail = log.tail(10);
      expect(tail).toBe('real');
    });

    it('isBroken starts false', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);
      expect(log.isBroken()).toBe(false);
    });

    it('marks broken on write failure and keeps broken', () => {
      // No permission dir (on Windows may not work, so we simulate by passing invalid path)
      const log = mod.createLogFile('/invalid/path/that/does/not/exist/app.log');
      log.write('should fail');
      expect(log.isBroken()).toBe(true);
      expect(log.problems().length).toBeGreaterThan(0);
    });

    it('tail returns empty when file missing', () => {
      const file = join(testDir, 'missing.log');
      const log = mod.createLogFile(file);
      expect(log.tail(10)).toBe('');
    });
  });

  describe('rotation', () => {
    it('rotates when file exceeds MAX_BYTES', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);

      // Write enough to exceed 2MB (MAX_BYTES)
      const bigLine = 'x'.repeat(1000) + '\n';
      const repeats = Math.ceil(2.1 * 1024 * 1024 / 1000);
      for (let i = 0; i < repeats; i++) {
        log.write('2024-01-01T00:00:00.000Z INFO ' + bigLine);
      }

      // Original should be rotated, new file should have recent lines
      const tail = log.tail(5);
      expect(tail).toContain('INFO');
    });

    it('keeps up to MAX_ROTATIONS files', () => {
      const file = join(testDir, 'app.log');
      const log = mod.createLogFile(file);

      const bigLine = 'x'.repeat(1000) + '\n';
      const repeats = Math.ceil(2.1 * 1024 * 1024 / 1000);
      // First rotation
      for (let i = 0; i < repeats; i++) log.write('a');
      // Second rotation
      for (let i = 0; i < repeats; i++) log.write('b');
      // Third rotation
      for (let i = 0; i < repeats; i++) log.write('c');

      // Should have app.log, app.log.1, app.log.2 (MAX_ROTATIONS = 2)
      const fs = await import('node:fs');
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.existsSync(`${file}.1`)).toBe(true);
      expect(fs.existsSync(`${file}.2`)).toBe(true);
      expect(fs.existsSync(`${file}.3`)).toBe(false);
    });
  });
});