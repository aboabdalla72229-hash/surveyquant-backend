'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const API_KEY = 'test-payment-api-key-for-regression-only';
const deviceId = 'SQ-PAYMENT-REGRESSION-DEVICE';
const order = 'SQ-REGRESSION-ORDER-001';
const now = Date.now();
const createdAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
const oldThreeDayTrial = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surveyquant-kashier-test-'));
const dataPath = path.join(tempDir, 'data.json');
const port = 18000 + Math.floor(Math.random() * 10000);
const store = {
  users: {
    ['device:' + deviceId]: {
      id: 'test-user-id', name: 'Regression Test', deviceId,
      createdAt, trialUntil: oldThreeDayTrial, activeUntil: null
    }
  },
  payments: {
    [order]: {
      order, deviceId, plan: 'monthly', amount: 55, currency: 'EGP',
      status: 'CREATED', createdAt: new Date(now).toISOString(),
      transactionId: null, subscriptionActivated: false
    }
  },
  webhookEvents: {}
};
fs.writeFileSync(dataPath, JSON.stringify(store, null, 2));

const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    SURVEYQUANT_DATA_DIR: tempDir,
    KASHIER_API_KEY: API_KEY,
    KASHIER_SECRET_KEY: 'unused-for-this-webhook-test',
    KASHIER_MID: 'MID-TEST-ONLY',
    PUBLIC_BASE_URL: 'https://example.invalid'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', x => { logs += x.toString(); });
child.stderr.on('data', x => { logs += x.toString(); });
const base = 'http://127.0.0.1:' + port;

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('backend exited early: ' + logs);
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('backend did not start: ' + logs);
}

function signData(data) {
  const keys = [...data.signatureKeys].sort();
  const payload = keys.map(k => k + '=' + encodeURIComponent(data[k] == null ? '' : String(data[k]))).join('&');
  return crypto.createHmac('sha256', API_KEY).update(payload).digest('hex');
}

async function sendWebhook(status) {
  const data = {
    merchantOrderId: 'KASHIER-INTERNAL-ID-DO-NOT-MATCH-LOCAL-ORDER',
    orderReference: order,
    transactionId: 'TX-REGRESSION-SAME-ID',
    status,
    signatureKeys: ['merchantOrderId', 'orderReference', 'status', 'transactionId']
  };
  const response = await fetch(base + '/api/kashier/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-kashier-signature': signData(data) },
    body: JSON.stringify({ event: 'pay', data })
  });
  return { response, body: await response.text() };
}

(async () => {
  try {
    await waitForServer();
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.trialDays, 7, 'backend must expose the advertised 7-day trial');

    const statusResponse = await fetch(base + '/api/status/' + encodeURIComponent(deviceId));
    assert.equal(statusResponse.status, 200);
    const userAfterTrialReconcile = await statusResponse.json();
    const cap = new Date(createdAt).getTime() + 7 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(new Date(userAfterTrialReconcile.trialUntil).getTime() - cap) < 1500,
      'existing old trial record should reconcile to createdAt + 7 days');

    const failed = await sendWebhook('FAILURE');
    assert.equal(failed.response.status, 200, 'signed failure webhook should be acknowledged');
    let dataAfter = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    assert.equal(dataAfter.payments[order].subscriptionActivated, false,
      'failure event must not activate subscription');

    const success = await sendWebhook('SUCCESS');
    assert.equal(success.response.status, 200, 'later success with same transaction id should be processed');
    dataAfter = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    assert.equal(dataAfter.payments[order].status, 'SUCCESS');
    assert.equal(dataAfter.payments[order].subscriptionActivated, true,
      'merchant orderReference must map to the local payment and activate access');
    assert.ok(new Date(dataAfter.users['device:' + deviceId].activeUntil).getTime() > Date.now(),
      'successful payment should set activeUntil');
    const activeUntil = dataAfter.users['device:' + deviceId].activeUntil;

    const duplicate = await sendWebhook('SUCCESS');
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body, 'Already processed');
    dataAfter = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    assert.equal(dataAfter.users['device:' + deviceId].activeUntil, activeUntil,
      'duplicate successful webhook must not extend the subscription twice');
    console.log('PASS: 7-day trial reconciliation, correct orderReference mapping, failure→success processing, and webhook idempotency.');
  } finally {
    if (child.exitCode === null) {
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2500);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.kill('SIGTERM');
      });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
