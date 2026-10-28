"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AuthService } = require("../backend/auth-service");

function createService(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-auth-pairing-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new AuthService({ dir: directory, sendJson() {}, readJsonBody() {} });
}

function activate(service, inviteCode, deviceId, deviceName) {
  return service.activate({ inviteCode, deviceId, deviceName });
}

const desktopId = "11111111-1111-4111-8111-111111111111";
const phoneId = "22222222-2222-4222-8222-222222222222";
const userDeviceId = "33333333-3333-4333-8333-333333333333";

test("desktop admin can pair mobile phone to share the same admin identity and permissions", (t) => {
  const service = createService(t);
  const initialInvite = service.initialize("secure-horse-battery-staple-admin", "管理员主设备");

  // 1. Desktop activates with initial invite
  const desktop = activate(service, initialInvite.code, desktopId, "电脑端");
  const desktopPrincipal = service.authenticate(`Bearer ${desktop.token}`);
  assert.equal(desktopPrincipal.admin, true);

  // 2. Desktop admin requests one-time pairing code for phone
  const pairing = service.createAdminPairingCode({ label: "管理员手机", ttlMinutes: 15 }, desktopPrincipal);
  assert.ok(pairing.code);
  assert.equal(pairing.admin, true);
  assert.equal(pairing.maxDevices, 1);
  assert.equal(pairing.userId, desktopPrincipal.userId);

  // 3. Phone activates with pairing code
  const phone = activate(service, pairing.code, phoneId, "手机端");
  const phonePrincipal = service.authenticate(`Bearer ${phone.token}`);
  assert.equal(phonePrincipal.admin, true);

  // 4. Verify same admin identity
  assert.equal(phonePrincipal.userId, desktopPrincipal.userId);
  assert.notEqual(phone.token, desktop.token);

  // 5. Pairing code is exhausted after 1 use
  assert.throws(() => activate(service, pairing.code, userDeviceId, "恶意设备"), /配对码已使用/);

  // 6. Non-admin cannot create pairing code
  const ordinaryInvite = service.createInvite({ label: "普通员工", maxDevices: 1 });
  const ordinary = activate(service, ordinaryInvite.code, userDeviceId, "员工电脑");
  const ordinaryPrincipal = service.authenticate(`Bearer ${ordinary.token}`);
  assert.equal(ordinaryPrincipal.admin, false);
  assert.notEqual(ordinaryPrincipal.userId, desktopPrincipal.userId);
  assert.throws(() => service.createAdminPairingCode({ label: "提权尝试" }, ordinaryPrincipal), /仅管理员可生成配对码/);

  // 7. Revocation: Desktop disables phone, phone is revoked immediately while desktop remains valid
  const store = service.read();
  const phoneDevice = store.devices.find((d) => d.id === phoneId);
  phoneDevice.disabled = true;
  service.write(store);

  assert.equal(service.authenticate(`Bearer ${phone.token}`), null);
  assert.equal(service.authenticate(`Bearer ${desktop.token}`)?.admin, true);
});

test("pairing rejects expiration, replay for same device and identity injection", (t) => {
 const service=createService(t);
 const invite=service.initialize("secure-horse-battery-staple-admin");
 const desktop=activate(service,invite.code,desktopId,"desktop");
 const principal=service.authenticate(`Bearer ${desktop.token}`);
 const forged=service.createInvite({userId:principal.userId,label:"ordinary",admin:false});
 assert.notEqual(forged.userId,principal.userId);
 const pair=service.createAdminPairingCode({},principal);
 const phone=activate(service,pair.code,phoneId,"phone");
 assert.throws(()=>service.activate({inviteCode:pair.code,deviceId:phoneId},{currentDeviceId:phoneId}),/配对码已使用/);
 assert.equal(service.authenticate(`Bearer ${phone.token}`).userId,principal.userId);
 const expired=service.createAdminPairingCode({},principal);
 const store=service.read();store.invites.find(i=>i.id===expired.id).expiresAt=new Date(0).toISOString();service.write(store);
 assert.throws(()=>activate(service,expired.code,userDeviceId,"expired"),/已过期/);
 assert.throws(()=>service.createAdminPairingCode({}, {admin:true,userId:"legacy",legacy:true}),/初始化/);
});
