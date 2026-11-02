import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alarmBody, buzzBody, CLIENT_HELLO, commandFrame, buildFrame, describeError, parseResponse, Reassembler, WhoopStrap,
} from '../whoop5.js';
import { createFakeBluetooth } from './fake-strap.js';

test('frame builder reproduces the known-good CLIENT_HELLO byte for byte', () => {
  assert.deepEqual(commandFrame(145, 1, [0x01]), CLIENT_HELLO);
});

test('the 12-byte buzz body pads to a 28-byte frame declaring 20', () => {
  const body = buzzBody(4);
  assert.equal(body.length, 12);
  assert.equal(body.at(-1), 3, 'repeats count the pulses after the first');
  const frame = commandFrame(19, 1, body);
  assert.equal(frame.length, 28);
  assert.equal(frame[2] | (frame[3] << 8), 20);
  assert.equal(buzzBody(1).at(-1), 0);
  assert.equal(buzzBody(99).at(-1), 7);
});

test('alarm body is the 21-byte revision-4 record', () => {
  const body = alarmBody(6, 1760230800500);
  assert.equal(body.length, 21);
  const view = new DataView(Uint8Array.from(body).buffer);
  assert.equal(body[0], 4);
  assert.equal(body[1], 6);
  assert.equal(view.getUint32(2, true), 1760230800);
  assert.equal(view.getUint16(6, true), 16384);
  assert.deepEqual(body.slice(8, 16), [47, 152, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(body.slice(16), [0, 0, 7, 30, 0]);
});

test('reassembler cuts fragmented, noisy input into checked frames', () => {
  const reply = buildFrame(38, 0x77, 66, [9, 1, 4, 1]);
  const corrupt = buildFrame(38, 1, 66, [1, 1]);
  corrupt[6] ^= 0xff;
  const stream = Uint8Array.from([0x00, 0x13, ...corrupt, ...reply]);
  const r = new Reassembler();
  const frames = [...r.feed(stream.slice(0, 5)), ...r.feed(stream.slice(5, 30)), ...r.feed(stream.slice(30))];
  assert.equal(frames.length, 1);
  // The body runs to the CRC, so it keeps the frame's zero padding.
  assert.deepEqual(parseResponse(frames[0]), { cmd: 66, seq: 9, result: 1, body: Uint8Array.of(4, 1, 0) });
});

async function connected(options) {
  const fake = createFakeBluetooth(options);
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: fake }, configurable: true });
  const strap = new WhoopStrap();
  await strap.connect();
  return { fake, strap };
}

test('connects, sends the hello, and round-trips alarm commands', async () => {
  const { fake, strap } = await connected();
  assert.ok(strap.connected);
  assert.deepEqual(fake.writes[0].frame, CLIENT_HELLO);

  assert.deepEqual(await strap.readAlarm(6), { slot: 6, seconds: 0 });

  const when = Date.now() + 60_000;
  assert.deepEqual(await strap.setAlarm(6, when), { ok: true, reason: 'accepted' });
  assert.equal(fake.slots.get(6), Math.floor(when / 1000));

  const past = await strap.setAlarm(5, Date.now() - 1000);
  assert.equal(past.ok, false);
  assert.equal(past.reason, 'time not in the future');

  assert.equal(await strap.clearAlarm(6), true);
  assert.equal(fake.slots.has(6), false);

  await strap.buzz(2);
  const buzz = fake.writes.at(-1);
  assert.equal(buzz.cmd, 19);
  assert.equal(buzz.body[11], 1);

  await strap.stopBuzz(); // resolves on the final reply, not the pending one
});

test('a bare-string rejection names the failed step instead of "undefined"', async () => {
  const fake = createFakeBluetooth({ failService: 'Service not found' });
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: fake }, configurable: true });
  const strap = new WhoopStrap();
  const log = [];
  strap.addEventListener('log', (e) => log.push(e.detail));
  await assert.rejects(strap.connect(), {
    message: 'Opening WHOOP service failed: Service not found',
    step: 'Opening WHOOP service',
  });
  assert.ok(log.includes('Opening WHOOP service failed: Service not found'));
});

test('describeError copes with strings, objects and DOMException-style errors', () => {
  assert.equal(describeError('Bluetooth is off'), 'Bluetooth is off');
  assert.equal(describeError({ code: 3 }), '{"code":3}');
  assert.equal(describeError({}), '[object Object]');
  assert.equal(describeError(undefined), 'unknown error');
  assert.equal(describeError({ name: 'NetworkError', message: 'GATT Server is disconnected.' }), 'NetworkError: GATT Server is disconnected.');
});

test('falls back to writeValue and logs the strap answering the hello', async () => {
  const { fake, strap } = await connected({ legacyWrite: true });
  const log = [];
  strap.addEventListener('log', (e) => log.push(e.detail));
  assert.ok(strap.connected);
  assert.deepEqual(fake.writes[0].frame, CLIENT_HELLO);
  assert.deepEqual(await strap.readAlarm(6), { slot: 6, seconds: 0 });
  assert.ok(log.includes('Strap answered'));
});

test('"all devices" drops the service filter but still asks for the WHOOP service', async () => {
  const fake = createFakeBluetooth();
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: fake }, configurable: true });
  const strap = new WhoopStrap();
  await strap.connect({ all: true });
  assert.ok(strap.connected);
  assert.equal(fake.requests[0].acceptAllDevices, true);
  assert.equal(fake.requests[0].filters, undefined);
  assert.deepEqual(fake.requests[0].optionalServices, ['fd4b0001-cce1-4033-93ce-002d5875f58a']);
});

test('pending requests fail when the strap disconnects', async () => {
  const { fake, strap } = await connected();
  const write = fake.device.gatt;
  const reply = strap.readAlarm(6);
  write.disconnect();
  await assert.rejects(reply, /disconnected/);
  assert.equal(strap.connected, false);
  await strap.reconnect();
  assert.equal(strap.connected, true);
  assert.deepEqual(await strap.readAlarm(6), { slot: 6, seconds: 0 });
});
