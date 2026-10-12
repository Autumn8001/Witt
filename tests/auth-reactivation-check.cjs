"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuthService } = require("../backend/auth-service");

function createService(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-auth-reactivation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new AuthService({ dir: directory, sendJson() {}, readJsonBody() {} });
}

function activate(service, invite, deviceId, extra = {}, options) {
  return service.activate({ inviteCode: invite.code, deviceId, deviceName: `device-${deviceId.slice(0, 4)}`, ...extra }, options);
}

const deviceA = "11111111-1111-4111-8111-111111111111";
const deviceB = "22222222-2222-4222-8222-222222222222";
const deviceC = "33333333-3333-4333-8333-333333333333";

test("admin invite can activate two devices with the same admin identity", (t) => {
  const service = createService(t);
  service.initialize("correct horse battery staple", "owner");
  const invite = service.createInvite({ label: "admin shared devices", maxDevices: 2, admin: true });

  const first = activate(service, invite, deviceA);
  const second = activate(service, invite, deviceB);

  assert.equal(first.device.userId, second.device.userId);
  assert.equal(first.device.admin, true);
  assert.equal(second.device.admin, true);
  assert.equal(service.authenticate(`Bearer ${first.token}`).userId, service.authenticate(`Bearer ${second.token}`).userId);
  assert.equal(service.read().invites.find((item) => item.id === invite.id).usedDevices, 2);
});

test("disabled device can be rebound and its prior token is invalidated", (t) => {
  const service = createService(t);
  service.initialize("correct horse battery staple", "owner");
  const originalInvite = service.createInvite({ label: "old account", maxDevices: 1 });
  const newInvite = service.createInvite({ label: "new admin account", maxDevices: 1, admin: true });
  const original = activate(service, originalInvite, deviceA);
  service.setUserPolicy(originalInvite.userId, { codexProfiles: ["default"] });
  const before = service.read();
  before.devices.find((item) => item.id === deviceA).disabled = true;
  service.write(before);

  const rebound = activate(service, newInvite, deviceA);
  const current = service.read();
  const device = current.devices.find((item) => item.id === deviceA);

  assert.equal(current.devices.filter((item) => item.id === deviceA).length, 1);
  assert.equal(device.userId, newInvite.userId);
  assert.equal(device.inviteId, newInvite.id);
  assert.equal(device.admin, true);
  assert.equal(device.disabled, false);
  assert.equal(service.authenticate(`Bearer ${original.token}`), null);
  assert.equal(service.authenticate(`Bearer ${rebound.token}`).admin, true);
  assert.equal(current.invites.find((item) => item.id === newInvite.id).usedDevices, 1);
  assert.equal(current.invites.find((item) => item.id === originalInvite.id).userId, originalInvite.userId);
  assert.deepEqual(current.userPolicies[originalInvite.userId].codexProfiles, ["default"]);
  assert.equal(current.userPolicies[newInvite.userId], undefined);
});

test("active device reactivation on its existing invite works at capacity without consuming another slot", (t) => {
  const service = createService(t);
  service.initialize("correct horse battery staple", "owner");
  const invite = service.createInvite({ label: "single device", maxDevices: 1 });
  const first = activate(service, invite, deviceA);

  const refreshed = activate(service, invite, deviceA);

  assert.notEqual(refreshed.token, first.token);
  assert.equal(service.authenticate(`Bearer ${first.token}`), null);
  assert.equal(service.authenticate(`Bearer ${refreshed.token}`).userId, invite.userId);
  assert.equal(service.read().invites.find((item) => item.id === invite.id).usedDevices, 1);
});

test("unknown device cannot activate after invite capacity is full and cannot self-assign admin", (t) => {
  const service = createService(t);
  service.initialize("correct horse battery staple", "owner");
  const invite = service.createInvite({ label: "single device", maxDevices: 1 });
  activate(service, invite, deviceA);

  assert.throws(() => activate(service, invite, deviceB, { admin: true }), /设备数量已满/);
  assert.equal(service.read().devices.some((item) => item.id === deviceB), false);
  assert.equal(service.read().devices.find((item) => item.id === deviceA).admin, false);
});

test("active device cannot be rebound to another account without its authenticated identity", (t) => {
  const service = createService(t);
  service.initialize("correct horse battery staple", "owner");
  const originalInvite = service.createInvite({ label: "original", maxDevices: 2 });
  const nextInvite = service.createInvite({ label: "next", maxDevices: 1, admin: true });
  const original = activate(service, originalInvite, deviceA);

  assert.throws(() => activate(service, nextInvite, deviceA, { currentDeviceId: deviceA }), /已绑定其他账号/);
  const rebound = activate(service, nextInvite, deviceA, {}, { currentDeviceId: deviceA });
  assert.equal(service.authenticate(`Bearer ${original.token}`), null);
  assert.equal(service.authenticate(`Bearer ${rebound.token}`).admin, true);
});

test("disabled and expired invitations remain invalid during device reactivation", (t) => {
  const service = createService(t);
  service.initialize("correct horse battery staple", "owner");
  const invite = service.createInvite({ label: "invite", maxDevices: 2 });
  const first = activate(service, invite, deviceA);
  const store = service.read();
  store.devices.find((item) => item.id === deviceA).disabled = true;
  store.invites.find((item) => item.id === invite.id).disabled = true;
  service.write(store);
  assert.throws(() => activate(service, invite, deviceA), /邀请码无效或已过期/);

  const expired = service.createInvite({ label: "expired", maxDevices: 2, expiresAt: new Date(Date.now() - 60_000).toISOString() });
  assert.throws(() => activate(service, expired, deviceB), /邀请码无效或已过期/);
  assert.equal(service.authenticate(`Bearer ${first.token}`), null);
});
