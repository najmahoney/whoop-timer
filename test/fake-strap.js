// A stand-in for navigator.bluetooth that answers like a WHOOP 5 strap, for
// tests in Node and for trying the page in a browser without a strap.

import { buildFrame, SERVICE } from '../whoop5.js';

const COMMAND_CHAR = 'fd4b0002-cce1-4033-93ce-002d5875f58a';
const REPLY_CHAR = 'fd4b0003-cce1-4033-93ce-002d5875f58a';
const TYPE_RESPONSE = 38;

class FakeCharacteristic extends EventTarget {
  value = null;
  constructor(uuid) {
    super();
    this.uuid = uuid;
  }
  async startNotifications() {
    return this;
  }
  emit(bytes) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

// occupied: { slot: epochSeconds } alarms already on the strap.
// rejectAlarms: answer every SET_ALARM_TIME with "time not in the future".
export function createFakeBluetooth({ occupied = {}, rejectAlarms = false } = {}) {
  const slots = new Map(Object.entries(occupied).map(([k, v]) => [Number(k), v]));
  const writes = [];
  const replies = new FakeCharacteristic(REPLY_CHAR);
  const command = new FakeCharacteristic(COMMAND_CHAR);
  let replySeq = 0;

  // Each reply is split across two notifications, as a real link may do.
  const reply = (cmd, originSeq, result, body = [], delay = 5) => {
    const frame = buildFrame(TYPE_RESPONSE, replySeq++ & 0xff, cmd, [originSeq, result, ...body]);
    setTimeout(() => {
      replies.emit(frame.slice(0, 7));
      replies.emit(frame.slice(7));
    }, delay);
  };

  command.writeValueWithResponse = async (data) => {
    const frame = new Uint8Array(data);
    if (!device.gatt.connected) throw new Error('GATT server is disconnected');
    const [seq, cmd] = [frame[9], frame[10]];
    const body = frame.slice(11);
    writes.push({ cmd, seq, body, frame });
    switch (cmd) {
      case 145: reply(145, seq, 1, [1]); break;
      case 19: break; // buzz: acknowledged at the GATT level only
      case 67: {
        const slot = body[1];
        reply(67, seq, 1, [4, slot, ...u32(slots.get(slot) ?? 0), 0, 0, 47, 152, 0, 0, 0, 0, 0, 0, 0, 0, 7, 30, 0]);
        break;
      }
      case 66: {
        const slot = body[1];
        const seconds = new DataView(body.buffer).getUint32(2, true);
        const ok = !rejectAlarms && seconds > Date.now() / 1000;
        if (ok) slots.set(slot, seconds);
        reply(66, seq, ok ? 1 : 0, [4, ok ? 1 : 10]);
        break;
      }
      case 69: slots.delete(body[1]); reply(69, seq, 1, [2]); break;
      case 122: reply(122, seq, 2, [1]); reply(122, seq, 1, [1], 25); break;
      default: reply(cmd, seq, 3); // unsupported
    }
  };

  const chars = new Map([[COMMAND_CHAR, command], [REPLY_CHAR, replies]]);
  const service = {
    async getCharacteristic(uuid) {
      const ch = chars.get(uuid);
      if (!ch) throw Object.assign(new Error(`No characteristic ${uuid}`), { name: 'NotFoundError' });
      return ch;
    },
  };
  const server = {
    async getPrimaryService(uuid) {
      if (uuid !== SERVICE) throw new Error(`No service ${uuid}`);
      return service;
    },
  };
  const device = new EventTarget();
  device.name = 'WHOOP 5A0TEST';
  device.gatt = {
    connected: false,
    async connect() {
      this.connected = true;
      return server;
    },
    disconnect() {
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };

  return {
    device,
    slots,
    writes,
    async requestDevice() {
      return device;
    },
    async getDevices() {
      return [device];
    },
  };
}
