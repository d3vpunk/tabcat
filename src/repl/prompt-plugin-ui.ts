import { useEffect, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { PROMPT_PLUGINS, PromptSegment } from './prompt-plugins.js';

export function usePromptPlugins(cwd: string, enabled: Readonly<Record<string, boolean>>, editing: boolean, finished: boolean): readonly PromptSegment[] {
  const [segments, setSegments] = useState<Record<string, PromptSegment>>({});
  const locked = useRef(false);
  if (editing || finished) locked.current = true;
  const active = PROMPT_PLUGINS.filter((plugin) => enabled[plugin.id] ?? plugin.defaultEnabled);
  const activeIds = active.map((plugin) => plugin.id).join(',');

  useEffect(() => {
    if (finished) return;
    const controller = new AbortController();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    for (const plugin of active) {
      const update = async () => {
        try {
          const segment = await plugin.collect({ cwd, signal: controller.signal });
          if (controller.signal.aborted) return;
          if (segment !== null && !(segment.side === 'left' && locked.current)) {
            setSegments((previous) => ({ ...previous, [plugin.id]: segment }));
          }
        } catch {
          // A provider failure must never interrupt command entry.
        }
        if (!controller.signal.aborted && plugin.intervalMs !== undefined) {
          timers.set(plugin.id, setTimeout(update, plugin.intervalMs - Date.now() % plugin.intervalMs));
        }
      };
      void update();
    }
    return () => {
      controller.abort();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [cwd, activeIds, finished]);

  return active.flatMap((plugin) => segments[plugin.id] ? [segments[plugin.id]!] : []);
}

/** Optional context gives way before the command's editing area does. */
export function promptLayout(columns: number, path: string, segments: readonly PromptSegment[], inputWidth: number) {
  const width = Math.max(1, columns);
  const inputReserve = Math.min(20, Math.max(1, width - 3));
  const prefixBudget = Math.max(0, width - inputReserve - 3);
  const left = segments.filter((segment) => segment.side === 'left');
  const leftWidth = left.reduce((sum, segment) => sum + stringWidth(segment.text) + 3, 0);
  const visibleLeft = leftWidth + Math.min(stringWidth(path), 12) <= prefixBudget ? left : [];
  const pluginWidth = visibleLeft.length > 0 ? leftWidth : 0;
  const pathWidth = Math.min(stringWidth(path), Math.max(0, prefixBudget - pluginWidth));
  const prefixWidth = pathWidth + pluginWidth + (width >= 4 ? 3 : width > 1 ? 1 : 0);
  const remaining = Math.max(1, width - prefixWidth);
  const right = segments.filter((segment) => segment.side === 'right');
  const rightWidth = right.reduce((sum, segment) => sum + stringWidth(segment.text) + 2, 0);
  const visibleRight = remaining - rightWidth >= Math.max(inputReserve, inputWidth + 1) ? right : [];
  return {
    pathWidth,
    left: visibleLeft,
    right: visibleRight,
    inputWidth: remaining - (visibleRight.length > 0 ? rightWidth : 0),
  };
}
