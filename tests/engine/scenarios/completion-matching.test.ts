import { describe, expect, it } from 'vitest';
import { HOURS, PROJECT_A, fakeFs, predictor, repeat } from './helpers.js';

describe('Scenario: case-insensitive matching', () => {
  it('history prefix matches case-insensitively, candidate keeps canonical spelling', () => {
    const p = predictor(repeat('Docker compose up', 2, 1 * HOURS));
    const prediction = p.predict({ line: 'doc', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display.startsWith('Docker')).toBe(true);
  });

  it('FS match is case-insensitive ("doc" finds "Documents/")', () => {
    const fs = fakeFs({ [PROJECT_A]: [{ name: 'Documents', isDir: true }] });
    const p = predictor([], fs);
    const prediction = p.predict({ line: 'doc', cursor: 3, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).toContain('Documents/');
  });
});

describe('Scenario: FS completion gate', () => {
  const fs = fakeFs({ [PROJECT_A]: [{ name: 'message.txt', isDir: false }] });

  it('bare word directly after a flag does not complete against the FS', () => {
    const p = predictor([], fs);
    const line = 'git commit -m mes';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).not.toContain('message.txt');
  });

  it('bare word without a flag completes against the FS when history is empty', () => {
    const p = predictor([], fs);
    const line = 'cat mes';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).toContain('message.txt');
  });

  it('path-like token (with /) completes even after a flag', () => {
    const deepFs = fakeFs({ [`${PROJECT_A}/src`]: [{ name: 'message.txt', isDir: false }] });
    const p = predictor([], deepFs);
    const line = 'git commit --message src/mes';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).toContain('message.txt');
  });

  it('bare word after "--" (end-of-options) completes against the FS', () => {
    const p = predictor([], fs);
    const line = 'rm -- mes';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).toContain('message.txt');
  });

  it('"~/" expands against the home directory instead of cwd', () => {
    const fs = fakeFs({ '/home/dev': [{ name: 'Documents', isDir: true }] });
    const p = predictor([], fs, '/home/dev');
    const line = 'cd ~/Doc';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).toContain('Documents/');
  });

  it('finished line (END beats context) with slash token keeps completing against the FS', () => {
    // The guard against FS flooding on a finished line must not hit explicitly
    // typed paths: "cd proj/" should list subdirectories despite END context.
    const fs = fakeFs({ [`${PROJECT_A}/proj`]: [{ name: 'sub', isDir: true }] });
    const p = predictor(repeat('cd proj/', 3, 1 * HOURS), fs);
    const line = 'cd proj/';
    const prediction = p.predict({ line, cursor: line.length, cwd: PROJECT_A });

    expect(prediction.candidates.map((c) => c.display)).toContain('sub/');
  });
});

describe('Scenario: shell-safe FS completion', () => {
  const fs = fakeFs({
    [PROJECT_A]: [
      { name: 'My File.txt', isDir: false },
      { name: 'My Folder', isDir: true },
      { name: '$draft.txt', isDir: false },
      { name: "Bob's notes", isDir: true },
    ],
    [`${PROJECT_A}/My Folder`]: [{ name: 'notes.txt', isDir: false }],
  });

  it('escapes spaces and metacharacters without quotes', () => {
    const p = predictor([], fs);

    expect(p.predict({ line: 'cat My', cursor: 6, cwd: PROJECT_A }).candidates[0]?.display).toBe(
      'My\\ File.txt',
    );
    expect(p.predict({ line: 'cat My', cursor: 6, cwd: PROJECT_A }).candidates[0]?.insert).toBe(
      '\\ File.txt',
    );
    const expansion = p.predict({ line: 'cat $', cursor: 5, cwd: PROJECT_A }).candidates[0];
    expect(expansion?.display).toBe('\\$draft.txt');
    expect(expansion?.insert).toBe('draft.txt');
  });

  it('leaves spaces raw inside double quotes but escapes expansion', () => {
    const p = predictor([], fs);
    const spaces = p.predict({ line: 'cat "My', cursor: 7, cwd: PROJECT_A });
    const expansion = p.predict({ line: 'cat "$', cursor: 6, cwd: PROJECT_A });

    expect(spaces.candidates[0]?.display).toBe('My File.txt');
    expect(expansion.candidates[0]?.display).toBe('\\$draft.txt');
  });

  it('escapes apostrophes inside single quotes and keeps the directory slash', () => {
    const p = predictor([], fs);
    const prediction = p.predict({ line: "cd 'Bob", cursor: 7, cwd: PROJECT_A });

    expect(prediction.candidates[0]?.display).toBe("Bob'\\''s notes/");
  });

  it('keeps completing inside already quoted or escaped directories', () => {
    const p = predictor([], fs);
    const quoted = p.predict({ line: 'cat "My Folder/no', cursor: 17, cwd: PROJECT_A });
    const escaped = p.predict({ line: 'cat My\\ Folder/no', cursor: 17, cwd: PROJECT_A });

    expect(quoted.candidates[0]?.display).toBe('notes.txt');
    expect(quoted.candidates[0]?.replacePrefixLength).toBe(2);
    expect(escaped.candidates[0]?.display).toBe('notes.txt');
    expect(escaped.candidates[0]?.replacePrefixLength).toBe(2);
  });
});

describe('Scenario: deterministic FS ordering', () => {
  it('sorts equal FS scores independently of readdir order', () => {
    const entries = [
      { name: 'azure', isDir: false },
      { name: 'Alpha', isDir: false },
      { name: 'amber', isDir: false },
    ];
    const first = predictor([], fakeFs({ [PROJECT_A]: entries }));
    const second = predictor([], fakeFs({ [PROJECT_A]: [...entries].reverse() }));
    const predict = (p: ReturnType<typeof predictor>) =>
      p.predict({ line: 'cat a', cursor: 5, cwd: PROJECT_A }).candidates.map((candidate) => candidate.display);

    expect(predict(first)).toEqual(predict(second));
    expect(predict(first)).toEqual(['Alpha', 'amber', 'azure']);
  });
});
