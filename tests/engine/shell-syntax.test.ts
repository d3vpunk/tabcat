import { describe, expect, it } from 'vitest';
import { cdTarget, simpleCommandWords } from '../../src/engine/shell-syntax.js';

describe('simpleCommandWords', () => {
  it('splits on unquoted whitespace and resolves quotes and escapes', () => {
    expect(simpleCommandWords(`cd "My Dir" 'x y' a\\ b`)).toEqual(['cd', 'My Dir', 'x y', 'a b']);
  });

  it('keeps only the last simple command of a compound line', () => {
    expect(simpleCommandWords('git pull && cd src')).toEqual(['cd', 'src']);
    expect(simpleCommandWords('make; cd build | tee log')).toEqual(['tee', 'log']);
  });

  it('operators inside quotes do not split commands', () => {
    expect(simpleCommandWords(`echo "a && b"`)).toEqual(['echo', 'a && b']);
  });

  it('ignores leading whitespace and an unfinished trailing word', () => {
    expect(simpleCommandWords('  cd pro')).toEqual(['cd', 'pro']);
    expect(simpleCommandWords('cd ')).toEqual(['cd']);
  });
});

describe('cdTarget', () => {
  it('is the first non-flag argument of a cd command', () => {
    expect(cdTarget('cd projects/radio')).toBe('projects/radio');
    expect(cdTarget('cd -P src')).toBe('src');
    expect(cdTarget('cd -- -weird')).toBe('-weird');
  });

  it('is empty for a bare cd, and `-` for the previous directory', () => {
    expect(cdTarget('cd')).toBe('');
    expect(cdTarget('cd ')).toBe('');
    expect(cdTarget('cd -')).toBe('-');
  });

  it('is null when the last simple command is not cd', () => {
    expect(cdTarget('cdk deploy')).toBeNull();
    expect(cdTarget('cd src && make')).toBeNull();
    expect(cdTarget('make')).toBeNull();
  });

  it('sees through builtin and command prefixes and a compound line', () => {
    expect(cdTarget('builtin cd src')).toBe('src');
    expect(cdTarget('git pull && cd src')).toBe('src');
    expect(cdTarget('  cd src')).toBe('src');
  });
});
