import type { PetCommand } from './brain/senses';

/**
 * Owner chat lines that talk to the pet. Only these exact words count, optionally after the pet's name ("초코 앉아",
 * "초코야, 앉아") and before closing punctuation ("앉아!"); anything else ("앉아서 쉬자") is ordinary chat.
 */
export type ChatIntent = { kind: 'command'; command: PetCommand } | { kind: 'praise' } | { kind: 'scold' };

export const COMMAND_WORDS: Readonly<Record<PetCommand, readonly string[]>> = {
  come: ['이리 와', '이리와', '와'],
  sit: ['앉아'],
  down: ['엎드려'],
  stay: ['기다려', '멈춰'],
  fetch: ['가져와', '물어와'],
  speak: ['짖어', '멍'],
  jump: ['점프', '뛰어'],
};
export const PRAISE_WORDS: readonly string[] = ['잘했어', '착하지', '옳지'];
export const SCOLD_WORDS: readonly string[] = ['안돼', '안 돼', '하지마'];

const PHRASES = new Map<string, ChatIntent>([
  ...Object.entries(COMMAND_WORDS).flatMap(([command, words]) =>
    words.map((word): [string, ChatIntent] => [word, { kind: 'command', command: command as PetCommand }]),
  ),
  ...PRAISE_WORDS.map((word): [string, ChatIntent] => [word, { kind: 'praise' }]),
  ...SCOLD_WORDS.map((word): [string, ChatIntent] => [word, { kind: 'scold' }]),
]);
/** Closing punctuation a command may end with. */
const TRAILING = /[\s!?.,~…！？～♡♥]+$/u;
/** Between the name and the word: a vocative (야/아) or a break (space, comma, exclamation). */
const AFTER_NAME = /^(?:(?:야|아)[\s,!~.…！～]*|[\s,!~.…！～]+)/u;

const tidy = (line: string) => line.normalize('NFC').replace(/\s+/gu, ' ').trim();

function phrase(rest: string): ChatIntent | null {
  const intent = PHRASES.get(rest.replace(TRAILING, ''));
  return intent ? { ...intent } : null;
}

/** What an owner's chat line asks of their pet, or null when it is not a pet command. */
export function parseChatLine(line: string, petName?: string | null): ChatIntent | null {
  if (typeof line !== 'string') return null;
  const said = tidy(line);
  if (!said || said.length > 40) return null;
  const direct = phrase(said);
  if (direct) return direct;
  const name = petName ? tidy(petName) : '';
  if (!name || said.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return null;
  const after = said.slice(name.length);
  const gap = AFTER_NAME.exec(after);
  const rest = gap ? after.slice(gap[0].length) : '';
  return rest ? phrase(rest) : null;
}
