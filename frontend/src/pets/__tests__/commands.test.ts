import { describe, expect, it } from 'vitest';

import { COMMAND_WORDS, PRAISE_WORDS, SCOLD_WORDS, parseChatLine } from '../commands';

const command = (name: string) => ({ kind: 'command', command: name });

describe('채팅으로 하는 명령', () => {
  it('이름을 앞에 붙여도 되고 끝 문장부호는 무시한다', () => {
    expect(parseChatLine('초코 앉아', '초코')).toEqual(command('sit'));
    expect(parseChatLine('앉아!')).toEqual(command('sit'));
    expect(parseChatLine('앉아!!', '초코')).toEqual(command('sit'));
    expect(parseChatLine('초코야, 앉아~', '초코')).toEqual(command('sit'));
    expect(parseChatLine('초코야 엎드려', '초코')).toEqual(command('down'));
    expect(parseChatLine('바둑아 기다려.', '바둑')).toEqual(command('stay'));
    expect(parseChatLine('  초코   이리   와  ', '초코')).toEqual(command('come'));
    expect(parseChatLine('Choco 짖어', 'choco')).toEqual(command('speak'));
  });

  it('칭찬과 꾸중을 구분한다', () => {
    expect(parseChatLine('안 돼')).toEqual({ kind: 'scold' });
    expect(parseChatLine('안돼!')).toEqual({ kind: 'scold' });
    expect(parseChatLine('초코 하지마', '초코')).toEqual({ kind: 'scold' });
    expect(parseChatLine('잘했어!')).toEqual({ kind: 'praise' });
    expect(parseChatLine('초코야 옳지', '초코')).toEqual({ kind: 'praise' });
    expect(parseChatLine('착하지~')).toEqual({ kind: 'praise' });
  });

  it('정해진 말만 명령이다', () => {
    expect(parseChatLine('앉아서 쉬자')).toBeNull();
    expect(parseChatLine('앉아서 쉬자', '초코')).toBeNull();
    expect(parseChatLine('앉아 앉아')).toBeNull();
    expect(parseChatLine('와 대박')).toBeNull();
    expect(parseChatLine('멍멍')).toBeNull();
    expect(parseChatLine('안녕')).toBeNull();
    expect(parseChatLine('')).toBeNull();
    expect(parseChatLine('   ')).toBeNull();
    expect(parseChatLine('!')).toBeNull();
    // Another name is talking to someone else; a name stuck to the word is not a call.
    expect(parseChatLine('철수 앉아', '초코')).toBeNull();
    expect(parseChatLine('초코앉아', '초코')).toBeNull();
    expect(parseChatLine('초코', '초코')).toBeNull();
    expect(parseChatLine('초코와 산책', '초코')).toBeNull();
  });

  it('어휘 전체가 해당 명령으로 읽힌다', () => {
    const expected = {
      come: ['이리 와', '이리와', '와'],
      sit: ['앉아'],
      down: ['엎드려'],
      stay: ['기다려', '멈춰'],
      fetch: ['가져와', '물어와'],
      speak: ['짖어', '멍'],
      jump: ['점프', '뛰어'],
    };
    expect(COMMAND_WORDS).toEqual(expected);
    for (const [name, words] of Object.entries(expected)) {
      for (const word of words) {
        expect(parseChatLine(word)).toEqual(command(name));
        expect(parseChatLine(`초코 ${word}!`, '초코')).toEqual(command(name));
      }
    }
    expect(PRAISE_WORDS).toEqual(['잘했어', '착하지', '옳지']);
    expect(SCOLD_WORDS).toEqual(['안돼', '안 돼', '하지마']);
  });

  it('한글 자모가 풀린 입력도 같은 말로 읽는다', () => {
    expect(parseChatLine('앉아'.normalize('NFD'))).toEqual(command('sit'));
    expect(parseChatLine('초코 앉아'.normalize('NFD'), '초코')).toEqual(command('sit'));
  });
});
