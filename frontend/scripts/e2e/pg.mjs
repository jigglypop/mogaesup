// Runs plain SQL on PostgreSQL over its wire protocol, enough for scripts/character-e2e.mjs to list, create and drop its
// throwaway databases without a client library: one connection per call, SCRAM-SHA-256, MD5 or password sign-in, and
// simple queries run one after another.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { connect } from 'node:net';

const int32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
};
/** A frontend message: strings end with a NUL, buffers go as they are. */
const message = (type, ...parts) => {
  const body = Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(`${part}\0`) : part)));
  return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]);
};
const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
const md5 = (text) => createHash('md5').update(text).digest('hex');

/** Backend messages as they arrive: each call to the returned function waits for the next one. */
function reader(socket) {
  let buffered = Buffer.alloc(0);
  let failure = null;
  const waiting = [];
  const pump = () => {
    while (waiting.length) {
      const length = buffered.length >= 5 ? buffered.readInt32BE(1) : Infinity;
      if (buffered.length >= length + 1) {
        const next = { type: String.fromCharCode(buffered[0]), body: buffered.subarray(5, length + 1) };
        buffered = buffered.subarray(length + 1);
        waiting.shift().resolve(next);
      } else if (failure) waiting.shift().reject(failure);
      else return;
    }
  };
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    pump();
  });
  socket.on('error', (error) => {
    failure = error;
    pump();
  });
  socket.on('close', () => {
    failure ??= new Error('PostgreSQL closed the connection');
    pump();
  });
  return () => new Promise((resolve, reject) => (waiting.push({ resolve, reject }), pump()));
}

function problem(body) {
  const fields = Object.fromEntries(
    body
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((field) => [field[0], field.slice(1)]),
  );
  return new Error(`PostgreSQL: ${fields.M ?? 'error'}${fields.C ? ` (${fields.C})` : ''}`);
}

/**
 * Runs each statement in turn on the database at `url` (postgres://user:password@host:port/db) and returns the last
 * one's rows, each an array of column texts.
 */
export async function sql(url, ...statements) {
  const target = new URL(url);
  const user = decodeURIComponent(target.username);
  const password = decodeURIComponent(target.password);
  const socket = connect({ host: target.hostname, port: Number(target.port || 5432) });
  const next = reader(socket);
  try {
    const startup = Buffer.concat([
      int32(196608),
      Buffer.from(`user\0${user}\0database\0${target.pathname.slice(1) || 'postgres'}\0\0`),
    ]);
    socket.write(Buffer.concat([int32(startup.length + 4), startup]));
    let nonce = '';
    let first = '';
    for (let ready = false; !ready;) {
      const { type, body } = await next();
      if (type === 'E') throw problem(body);
      if (type === 'Z') ready = true;
      if (type !== 'R') continue;
      const code = body.readInt32BE(0);
      if (code === 3) socket.write(message('p', password));
      else if (code === 5)
        socket.write(message('p', `md5${md5(Buffer.concat([Buffer.from(md5(password + user)), body.subarray(4, 8)]))}`));
      else if (code === 10) {
        nonce = randomBytes(18).toString('base64');
        first = `n=,r=${nonce}`;
        socket.write(message('p', 'SCRAM-SHA-256', int32(first.length + 3), Buffer.from(`n,,${first}`)));
      } else if (code === 11) {
        const challenge = body.subarray(4).toString();
        const fields = Object.fromEntries(challenge.split(',').map((field) => [field[0], field.slice(2)]));
        if (!fields.r?.startsWith(nonce)) throw new Error('PostgreSQL answered SCRAM with a foreign nonce');
        const salted = pbkdf2Sync(password, Buffer.from(fields.s, 'base64'), Number(fields.i), 32, 'sha256');
        const clientKey = hmac(salted, 'Client Key');
        const final = `c=biws,r=${fields.r}`;
        const signature = hmac(createHash('sha256').update(clientKey).digest(), `${first},${challenge},${final}`);
        const proof = Buffer.from(clientKey.map((byte, index) => byte ^ signature[index]));
        socket.write(message('p', Buffer.from(`${final},p=${proof.toString('base64')}`)));
      } else if (code !== 0 && code !== 12) throw new Error(`PostgreSQL asked for sign-in method ${code}`);
    }
    let rows = [];
    for (const statement of statements) {
      socket.write(message('Q', statement));
      let failure = null;
      rows = [];
      for (let type = ''; type !== 'Z';) {
        const { type: kind, body } = await next();
        type = kind;
        if (type === 'E') failure = problem(body);
        if (type !== 'D') continue;
        // A data row: a column count, then each column's length (-1 for NULL) and text.
        const row = [];
        for (let column = 0, at = 2; column < body.readInt16BE(0); column++) {
          const length = body.readInt32BE(at);
          row.push(length < 0 ? null : body.subarray(at + 4, at + 4 + length).toString());
          at += 4 + Math.max(length, 0);
        }
        rows.push(row);
      }
      if (failure) throw failure;
    }
    socket.end(message('X'));
    return rows;
  } finally {
    socket.destroy();
  }
}
