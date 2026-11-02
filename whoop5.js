// Minimal WHOOP 5.0 / MG Bluetooth client: buzz the strap and use its own
// alarm slots as a timer. Byte layouts come from the community
// reverse-engineering in github.com/eugenehp/whoop-rs (src/protocol).
// WHOOP does not document or support any of this.

export const SERVICE = 'fd4b0001-cce1-4033-93ce-002d5875f58a';
const COMMAND_CHAR = 'fd4b0002-cce1-4033-93ce-002d5875f58a';
const NOTIFY_CHARS = ['fd4b0003', 'fd4b0004', 'fd4b0005', 'fd4b0007'].map(
  (prefix) => `${prefix}-cce1-4033-93ce-002d5875f58a`,
);

export const Cmd = Object.freeze({
  RUN_HAPTIC_PATTERN: 19,
  SET_ALARM_TIME: 66,
  GET_ALARM_TIME: 67,
  DISABLE_ALARM: 69,
  STOP_HAPTICS: 122,
  GET_HELLO: 145,
});

// The only commands this app will send. Anything that touches history, the
// clock, bonds or firmware is refused before a frame is built.
const ALLOWED = new Set(Object.values(Cmd));

const TYPE_COMMAND = 35;
const RESPONSE_TYPES = new Set([36, 38]);
const RESULT_SUCCESS = 1;
const RESULT_PENDING = 2;

// The waveform pair WHOOP uses for both its notification buzz and its alarm.
const WAVEFORM = [47, 152, 0, 0, 0, 0, 0, 0];

// Fixed first write after connecting: GET_HELLO, revision 1, sequence 1.
export const CLIENT_HELLO = Uint8Array.of(
  0xaa, 0x01, 0x08, 0x00, 0x00, 0x01, 0xe6, 0x71, 0x23, 0x01, 0x91, 0x01, 0x36, 0x3e, 0x5c, 0x8d,
);

const ALARM_DETAILS = {
  1: 'accepted',
  2: 'effect out of range',
  3: 'repeat count out of range',
  4: 'duration out of range',
  10: 'time not in the future',
  11: 'alarm slot out of range',
  12: 'crescendo out of range',
};

// ── Checksums ────────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

// ── Frames ───────────────────────────────────────────────────────────────────

// AA 01 │ declared len u16le │ 00 01 │ crc16 │ type seq cmd body… pad │ crc32
// The inner record is zero-padded to four bytes before the length and CRC32
// are computed; without that the strap rejects the 12-byte haptics body.
export function buildFrame(type, seq, cmd, body = []) {
  const innerLen = 3 + body.length;
  const padded = innerLen + ((4 - (innerLen % 4)) % 4);
  const declared = padded + 4;
  const frame = new Uint8Array(8 + padded + 4);
  frame.set([0xaa, 0x01, declared & 0xff, declared >> 8, 0x00, 0x01]);
  const header = crc16Modbus(frame.subarray(0, 6));
  frame[6] = header & 0xff;
  frame[7] = header >> 8;
  frame.set([type, seq, cmd, ...body], 8);
  new DataView(frame.buffer).setUint32(8 + padded, crc32(frame.subarray(8, 8 + padded)), true);
  return frame;
}

export const commandFrame = (cmd, seq, body) => buildFrame(TYPE_COMMAND, seq, cmd, body);

// A reply echoes the request's sequence at [11]; the frame's own sequence at
// [9] is generated fresh by the strap and is not used for matching.
export function parseResponse(frame) {
  if (frame.length < 20 || !RESPONSE_TYPES.has(frame[8])) return null;
  const end = frame.length - 4;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (crc32(frame.subarray(8, end)) !== view.getUint32(end, true)) return null;
  return { cmd: frame[10], seq: frame[11], result: frame[12], body: frame.slice(13, end) };
}

// Notifications can split or join frames, so bytes are buffered per channel
// and cut on the header checksum.
export class Reassembler {
  #buf = new Uint8Array(0);

  feed(chunk) {
    let buf = new Uint8Array(this.#buf.length + chunk.length);
    buf.set(this.#buf);
    buf.set(chunk, this.#buf.length);
    const frames = [];
    while (buf.length) {
      const start = buf.indexOf(0xaa);
      if (start < 0) {
        buf = buf.subarray(buf.length);
        break;
      }
      buf = buf.subarray(start);
      if (buf.length < 8) break;
      const total = (buf[2] | (buf[3] << 8)) + 8;
      const headerOk = crc16Modbus(buf.subarray(0, 6)) === (buf[6] | (buf[7] << 8));
      if (!headerOk || total < 13 || total > 8192) {
        buf = buf.subarray(1);
        continue;
      }
      if (buf.length < total) break;
      frames.push(buf.slice(0, total));
      buf = buf.subarray(total);
    }
    this.#buf = buf.slice();
    return frames;
  }
}

// ── Command bodies ───────────────────────────────────────────────────────────

// RUN_HAPTIC_PATTERN: [rev 1][waveform ×8][loop control u16le][repeats after the first pulse]
export const buzzBody = (pulses) => [0x01, ...WAVEFORM, 0x00, 0x00, Math.min(8, Math.max(1, pulses)) - 1];

// SET_ALARM_TIME rev 4: [4][slot][epoch s u32le][1/32768 s u16le][waveform ×8]
// [loop control u16le][repeats][duration][crescendo]. Repeats 7 with duration
// 30 is the only combination seen in captured alarms.
export function alarmBody(slot, epochMs) {
  const seconds = Math.floor(epochMs / 1000);
  const ticks = Math.floor(((epochMs % 1000) * 32768) / 1000);
  return [
    0x04, slot,
    seconds & 0xff, (seconds >>> 8) & 0xff, (seconds >>> 16) & 0xff, (seconds >>> 24) & 0xff,
    ticks & 0xff, ticks >> 8,
    ...WAVEFORM,
    0x00, 0x00, 7, 30, 0,
  ];
}

// ── Connection ───────────────────────────────────────────────────────────────

export class WhoopStrap extends EventTarget {
  device = null;
  #command = null;
  #listeners = [];
  #pending = new Map();
  #queue = Promise.resolve();
  #seq = 2 + Math.floor(Math.random() * 200);

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get connected() {
    return !!this.#command && !!this.device?.gatt?.connected;
  }

  get name() {
    return this.device?.name || 'WHOOP strap';
  }

  // Opens the browser's device chooser, so it must run from a tap.
  async connect() {
    this.#adopt(
      await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE] }],
        optionalServices: [SERVICE],
      }),
    );
    await this.#open();
  }

  // Reconnects to a strap picked earlier on this page.
  async reconnect() {
    if (!this.device) throw new Error('No strap picked yet');
    if (!this.connected) await this.#open();
  }

  // Reconnects without a tap to a strap this site was allowed to use before,
  // where the browser supports that.
  async restore() {
    const devices = (await navigator.bluetooth.getDevices?.()) ?? [];
    const device = devices.find((d) => /whoop/i.test(d.name ?? '')) ?? devices[0];
    if (!device) return false;
    this.#adopt(device);
    await this.#open();
    return true;
  }

  buzz(pulses = 2) {
    return this.#send(Cmd.RUN_HAPTIC_PATTERN, buzzBody(pulses));
  }

  async readAlarm(slot) {
    const reply = await this.#request(Cmd.GET_ALARM_TIME, [0x04, slot], 4000);
    const b = reply.body;
    if (reply.result !== RESULT_SUCCESS || b[0] !== 4 || b.length < 21) return null;
    return { slot: b[1], seconds: new DataView(b.buffer, b.byteOffset).getUint32(2, true) };
  }

  async setAlarm(slot, epochMs) {
    const reply = await this.#request(Cmd.SET_ALARM_TIME, alarmBody(slot, epochMs));
    const detail = reply.body[1] ?? 0;
    return {
      ok: reply.result === RESULT_SUCCESS && detail === 1,
      reason: ALARM_DETAILS[detail] ?? `strap replied ${reply.result}/${detail}`,
    };
  }

  async clearAlarm(slot) {
    const reply = await this.#request(Cmd.DISABLE_ALARM, [0x02, slot]);
    return reply.result === RESULT_SUCCESS;
  }

  // Stops a buzz in progress. The strap answers "pending" first, then the result.
  async stopBuzz() {
    await this.#request(Cmd.STOP_HAPTICS, [0x01], 12000);
  }

  #adopt(device) {
    if (device === this.device) return;
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this.#dropped());
  }

  async #open() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    const command = await service.getCharacteristic(COMMAND_CHAR);

    for (const { ch, handler } of this.#listeners) ch.removeEventListener('characteristicvaluechanged', handler);
    this.#listeners = [];
    for (const uuid of NOTIFY_CHARS) {
      try {
        const ch = await service.getCharacteristic(uuid);
        const reassembler = new Reassembler();
        const handler = (event) => {
          const v = event.target.value;
          for (const frame of reassembler.feed(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))) {
            this.#onFrame(frame);
          }
        };
        ch.addEventListener('characteristicvaluechanged', handler);
        this.#listeners.push({ ch, handler });
        await ch.startNotifications();
      } catch {
        // Not every firmware exposes all four channels.
      }
    }

    await command.writeValueWithResponse(CLIENT_HELLO);
    this.#command = command;
    this.dispatchEvent(new Event('connected'));
  }

  #dropped() {
    this.#command = null;
    for (const waiter of this.#pending.values()) waiter.reject(new Error('Strap disconnected'));
    this.#pending.clear();
    this.dispatchEvent(new Event('disconnected'));
  }

  #onFrame(frame) {
    const reply = parseResponse(frame);
    if (!reply || reply.result === RESULT_PENDING) return;
    const key = `${reply.cmd}:${reply.seq}`;
    const waiter = this.#pending.get(key);
    if (!waiter) return;
    this.#pending.delete(key);
    waiter.resolve(reply);
  }

  #nextSeq() {
    this.#seq = (this.#seq + 1) & 0xff;
    return this.#seq;
  }

  #guard(cmd) {
    if (!ALLOWED.has(cmd)) throw new Error(`Refusing to send command ${cmd}`);
  }

  // GATT allows one operation at a time, so writes go through a queue.
  #write(frame) {
    const run = this.#queue.then(() => {
      if (!this.#command) throw new Error('Strap is not connected');
      return this.#command.writeValueWithResponse(frame);
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #send(cmd, body) {
    this.#guard(cmd);
    await this.#write(commandFrame(cmd, this.#nextSeq(), body));
  }

  async #request(cmd, body, timeoutMs = 8000) {
    this.#guard(cmd);
    const seq = this.#nextSeq();
    const key = `${cmd}:${seq}`;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new Error(`No reply from the strap (command ${cmd})`));
      }, timeoutMs);
      this.#pending.set(key, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    try {
      await this.#write(commandFrame(cmd, seq, body));
    } catch (e) {
      this.#pending.get(key)?.reject(e);
      this.#pending.delete(key);
    }
    return reply;
  }
}
