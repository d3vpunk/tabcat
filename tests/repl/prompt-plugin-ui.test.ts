import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { promptLayout } from '../../src/repl/prompt-plugin-ui.js';
import { PromptSegment } from '../../src/repl/prompt-plugins.js';

const git: PromptSegment = { text: 'main *', tone: 'muted', side: 'left' };
const clock: PromptSegment = { text: '14:32', tone: 'muted', side: 'right' };

describe('prompt plugin layout', () => {
  it('measures CJK paths and branches in terminal columns', () => {
    const branch = { ...git, text: '分支开发' };
    const path = '~/项目';
    const layout = promptLayout(50, path, [branch, clock], 0);
    expect(layout.pathWidth).toBe(6);
    expect(layout.left).toEqual([branch]);
    expect(layout.pathWidth + stringWidth(branch.text) + 3 + 3 + layout.inputWidth + 7).toBe(50);
    expect(promptLayout(40, path, [{ ...git, text: '分'.repeat(8) }], 0).left).toEqual([]);
  });

  it('drops right context based on command and segment cell widths', () => {
    expect(promptLayout(50, '~/project', [git, clock], stringWidth('界'.repeat(12))).right).toEqual([]);
    expect(promptLayout(40, '~/project', [{ ...clock, text: '时间时间' }], 0).right).toEqual([]);
  });

  it('shares one line between path, plugins and input', () => {
    const layout = promptLayout(80, '~/project', [git, clock], 10);
    expect(layout.left).toEqual([git]);
    expect(layout.right).toEqual([clock]);
    expect(layout.pathWidth + 3 + 9 + layout.inputWidth + 7).toBe(80);
  });

  it('drops the clock before sacrificing command space', () => {
    const layout = promptLayout(50, '~/project', [git, clock], 26);
    expect(layout.left).toEqual([git]);
    expect(layout.right).toEqual([]);
  });

  it('drops context and truncates the path on narrow terminals', () => {
    const layout = promptLayout(30, '/a/very/long/project/path', [git, clock], 0);
    expect(layout.left).toEqual([]);
    expect(layout.right).toEqual([]);
    expect(layout.pathWidth).toBe(7);
    expect(layout.inputWidth).toBe(20);
  });

  it('bounds an unusually long branch instead of wrapping', () => {
    const layout = promptLayout(80, '~/project', [{ ...git, text: 'x'.repeat(100) }], 0);
    expect(layout.left).toEqual([]);
    expect(layout.pathWidth + 3 + layout.inputWidth).toBe(80);
  });

  it('retains the original context when plugins are disabled', () => {
    const layout = promptLayout(80, '~/project', [], 0);
    expect(layout.left).toEqual([]);
    expect(layout.right).toEqual([]);
    expect(layout.inputWidth).toBe(68);
  });

  it('keeps even tiny layouts within the terminal width', () => {
    for (let columns = 1; columns < 30; columns++) {
      const layout = promptLayout(columns, '/long/path', [git, clock], 0);
      const marker = columns >= 4 ? 3 : columns > 1 ? 1 : 0;
      expect(layout.pathWidth + marker + layout.inputWidth).toBe(columns);
      expect(layout.left).toEqual([]);
      expect(layout.right).toEqual([]);
    }
  });
});
