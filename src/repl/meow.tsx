import { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

const FRAME_MS = 200;

// Proud cat in profile, nose to the right, raised tail, four
// legs with paws. The ground scrolls away beneath her: she walks in
// place, which reads as marching to the right. All rows have
// fixed width so the content below does not jump.
const BACK = '  \\______/      \\';
const BELLY = '   \\____________/';

// Tail flicks left/right: the tip moves, the base bends along.
const TAIL_ORDER = [0, 1, 0, 2] as const;
const TAILS = [
  { tip: '  ~', stem1: '  |' },
  { tip: '   ~', stem1: '  \\' },
  { tip: ' ~', stem1: '  /' },
] as const;

// Trot: diagonally offset, one hind and one front leg lift
// (bent crouch, paw in the air), the standing legs carry — this way
// two legs never cross.
const WALK = [
  { legs: '    ) |     | )', paws: '      |_   |_' },
  { legs: '    | |     | |', paws: '    |_|_|    |_|_' },
  { legs: '    | )     ) |', paws: '    |_       |_' },
  { legs: '    | |     | |', paws: '    |_|_|    |_|_' },
] as const;

const GROUND_WIDTH = 22;

export interface MeowFrame {
  tailTip: string;
  tailStem1: string;
  tailStem2: string;
  eyes: string;
  legs: string;
  paws: string;
  ground: string;
}

// Pebbles on the ground, moving one column to the left per frame.
function groundRow(offset: number): string {
  let line = '';
  for (let x = 0; x < GROUND_WIDTH; x += 1) {
    const pos = x + offset;
    line += pos % 8 === 0 ? '.' : pos % 8 === 1 ? ',' : ' ';
  }
  return line;
}

export function meowFrame(index: number): MeowFrame {
  const tail = TAILS[TAIL_ORDER[index % TAIL_ORDER.length] as number] ?? TAILS[0];
  const walk = WALK[index % WALK.length] ?? WALK[0];
  return {
    tailTip: tail.tip,
    tailStem1: tail.stem1,
    tailStem2: '  |',
    eyes: index % 9 === 7 ? '-  -' : index % 6 === 3 ? '^  ^' : 'o  o',
    legs: walk.legs,
    paws: walk.paws,
    ground: groundRow(index),
  };
}

export function MeowAnimation({ frame }: { frame: number }) {
  const current = meowFrame(frame);
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Box
        flexDirection="column"
        marginLeft={2}
        paddingLeft={1}
        borderStyle="single"
        borderColor="gray"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
      >
        <Text bold color="cyan">🐱 tabcat :meow</Text>
        <Text dimColor>─</Text>
        <Box marginLeft={2} flexDirection="column">
          <Text color="magenta">{current.tailTip}</Text>
          <Text>
            <Text color="magenta">{current.tailStem1}</Text>
            <Text color="white">       /\  /\</Text>
          </Text>
          <Text>
            <Text color="magenta">{current.tailStem2}</Text>
            <Text color="white">{'      ( '}</Text>
            <Text bold color="yellow">{current.eyes}</Text>
            <Text color="white"> )&gt;</Text>
          </Text>
          <Text color="white">{BACK}</Text>
          <Text color="white">{BELLY}</Text>
          <Text color="white">{current.legs}</Text>
          <Text color="white">{current.paws}</Text>
          <Text dimColor>{current.ground}</Text>
        </Box>
        <Text> </Text>
        <Text color="blue">on patrol.</Text>
        <Text dimColor>press any key to exit</Text>
      </Box>
      <Text> </Text>
    </Box>
  );
}

function MeowPlayer() {
  const { exit } = useApp();
  const [frame, setFrame] = useState(0);
  const [finished, setFinished] = useState(false);

  useInput(() => setFinished(true));

  useEffect(() => {
    if (finished) {
      const timer = setTimeout(exit, FRAME_MS);
      return () => clearTimeout(timer);
    }
    // Endless loop: only a keypress ends the animation.
    const timer = setTimeout(() => setFrame((value) => value + 1), FRAME_MS);
    return () => clearTimeout(timer);
  }, [exit, finished, frame]);

  return <MeowAnimation frame={frame} />;
}

export async function showMeowAnimation(): Promise<void> {
  const instance = render(<MeowPlayer />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}
