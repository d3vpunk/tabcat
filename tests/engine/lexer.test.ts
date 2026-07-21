import { describe, expect, it } from 'vitest';
import { join, lex } from '../../src/engine/lexer.js';

describe('lexer', () => {
  it('splits the canonical tool command into small chunks', () => {
    const chunks = lex('vendor/bin/tool --filter="module/contractname.md"');
    expect(chunks.map((c) => c.text)).toEqual([
      'vendor', '/', 'bin', '/', 'tool',
      ' ',
      '--', 'filter', '=', '"',
      'module', '/', 'contractname.md',
      '"',
    ]);
  });

  it('marks chunk kinds correctly', () => {
    const chunks = lex('docker compose -f deploy/docker-compose.yaml run php');
    const byText = new Map(chunks.map((c) => [c.text, c.kind]));
    expect(byText.get('docker')).toBe('word');
    expect(byText.get('-')).toBe('flag');
    expect(byText.get('/')).toBe('sep');
    expect(byText.get('docker-compose.yaml')).toBe('word');
  });

  it('does not treat hyphens inside words as flags', () => {
    const chunks = lex('docker-compose up');
    expect(chunks[0]).toEqual({ text: 'docker-compose', kind: 'word' });
  });

  it('lexes pipes and operators', () => {
    const texts = lex('tool | grep fail && echo ok').map((c) => c.text);
    expect(texts).toContain('|');
    expect(texts).toContain('&&');
  });

  it('Roundtrip: join(lex(line)) === line', () => {
    const lines = [
      'vendor/bin/tool --filter="module/contractname.md"',
      'docker compose -f deploy/docker-compose.yaml run php vendor/bin/tool',
      'git commit -m "fix: something | Jira PROJ-123"',
      "echo 'hello   world'  |  wc -l",
      'ls -la ~/projects && cd ..',
      'FOO=bar npm run test -- --watch',
      '',
      '   ',
      'a',
    ];
    for (const line of lines) {
      expect(join(lex(line))).toBe(line);
    }
  });
});
