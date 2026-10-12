'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 8080);

// Keep subscription/payment records on Railway's mounted persistent volume.
const DATA_DIR = process.env.SURVEYQUANT_DATA_DIR || '/app/data';
const DATA = path.join(DATA_DIR, 'data.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const KASHIER_MODE =
  String(process.env.KASHIER_MODE || 'test').toLowerCase() === 'live'
    ? 'live'
    : 'test';
const KASHIER_API_BASE =
  KASHIER_MODE === 'live'
    ? 'https://api.kashier.io'
    : 'https://test-api.kashier.io';
const KASHIER_REFUND_API_BASE =
  KASHIER_MODE === 'live'
    ? 'https://fep.kashier.io'
    : 'https://test-fep.kashier.io';

const KASHIER_API_KEY = process.env.KASHIER_API_KEY || '';
const KASHIER_SECRET_KEY = process.env.KASHIER_SECRET_KEY || '';
const KASHIER_MID = process.env.KASHIER_MID || '';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const TRIAL_DAYS = 3;

// Only explicitly listed device IDs are exempt from payment.
const OWNER_DEVICE_IDS = new Set(
  String(process.env.SURVEYQUANT_OWNER_DEVICE_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const OWNER_ACCESS_UNTIL = '2099-12-31T23:59:59.000Z';
const MINIMUM_APP_VERSION_CODE = Number(process.env.MINIMUM_APP_VERSION_CODE || 93);
const LATEST_APP_VERSION_NAME = process.env.LATEST_APP_VERSION_NAME || '1.0.93';
const UPDATE_URL = process.env.UPDATE_URL ||
  'https://github.com/aboabdalla72229-hash/SurveyQuantAndroid_v1.0.57/releases/download/v1.0.93/SurveyQuant_v1.0.93.apk';

const PLANS = {
  monthly: { amount: 55, days: 30, label: 'شهري' },
  quarterly: { amount: 150, days: 90, label: '3 شهور' },
  yearly: { amount: 500, days: 365, label: 'سنوي' }
};

function emptyStore() {
  return { users: {}, payments: {}, webhookEvents: {} };
}

if (!fs.existsSync(DATA)) {
  fs.writeFileSync(DATA, JSON.stringify(emptyStore(), null, 2), 'utf8');
}

function readStore() {
  const parsed = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  if (!parsed.users) parsed.users = {};
  if (!parsed.payments) parsed.payments = {};
  if (!parsed.webhookEvents) parsed.webhookEvents = {};
  return parsed;
}

function writeStore(store) {
  const temporaryPath = `${DATA}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temporaryPath, DATA);
}

function isOwnerDevice(deviceId) {
  return OWNER_DEVICE_IDS.has(String(deviceId || '').trim());
}

function accessPayload(user, deviceId) {
  const ownerExempt = isOwnerDevice(deviceId);
  const now = Date.now();
  return {
    ...user,
    ownerExempt,
    trialActive: ownerExempt || Boolean(user.trialUntil && new Date(user.trialUntil).getTime() > now),
    subscriptionActive: ownerExempt || Boolean(user.activeUntil && new Date(user.activeUntil).getTime() > now),
    trialUntil: ownerExempt ? OWNER_ACCESS_UNTIL : user.trialUntil,
    activeUntil: ownerExempt ? OWNER_ACCESS_UNTIL : (user.activeUntil || null)
  };
}

function enforceTrialDuration(user) {
  if (!user || !user.createdAt) return;
  const cap = new Date(new Date(user.createdAt).getTime() + TRIAL_DAYS * 86400000);
  const current = user.trialUntil ? new Date(user.trialUntil) : null;
  if (!current || !Number.isFinite(current.getTime()) || current.getTime() > cap.getTime()) {
    user.trialUntil = cap.toISOString();
  }
}

function requireKashierConfig() {
  if (!KASHIER_API_KEY || !KASHIER_SECRET_KEY || !KASHIER_MID || !PUBLIC_BASE_URL) {
    const error = new Error('لم يتم إعداد مفاتيح Kashier أو PUBLIC_BASE_URL على السيرفر بعد');
    error.statusCode = 503;
    throw error;
  }
}

async function requestAutomaticRefund(store, payment, webhookData, reason) {
  const currentStatus = String(payment.refundStatus || '').toUpperCase();
  if (['REQUESTED', 'SUCCESS', 'PENDING', 'FAILURE', 'MANUAL_REVIEW_REQUIRED', 'PENDING_REVIEW'].includes(currentStatus)) {
    return;
  }

  const providerOrderId = String(
    (webhookData && webhookData.kashierOrderId) || payment.kashierOrderId || ''
  ).trim();
  const transactionId = String(
    (webhookData && webhookData.transactionId) || payment.transactionId || ''
  ).trim();

  payment.kashierOrderId = providerOrderId || payment.kashierOrderId || null;
  payment.refundReason = reason;
  payment.refundRequestedAt = new Date().toISOString();

  if (!KASHIER_SECRET_KEY || !providerOrderId) {
    payment.refundStatus = 'MANUAL_REVIEW_REQUIRED';
    payment.refundError = !KASHIER_SECRET_KEY
      ? 'KASHIER_SECRET_KEY is not configured.'
      : 'Kashier order ID is missing from the payment/webhook record.';
    writeStore(store);
    console.error('Automatic refund requires manual review:', payment.order, payment.refundError);
    return;
  }

  // Persist the request marker before contacting Kashier to reduce duplicate refund attempts.
  payment.refundStatus = 'REQUESTED';
  payment.refundError = null;
  writeStore(store);

  try {
    const refundBody = {
      apiOperation: 'REFUND',
      reason: 'SurveyQuant automatic refund: subscription activation failed',
      transaction: transactionId ? { targetTransactionId: transactionId } : {}
    };
    const response = await fetch(
      `${KASHIER_REFUND_API_BASE}/v3/orders/${encodeURIComponent(providerOrderId)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: KASHIER_SECRET_KEY,
          accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(refundBody)
      }
    );
    const result = await response.json().catch(() => ({}));
    const providerStatus = String(
      result.status || (result.response && result.response.status) || ''
    ).toUpperCase();

    if (response.ok && ['SUCCESS', 'PENDING', 'FAILURE'].includes(providerStatus)) {
      payment.refundStatus = providerStatus;
    } else {
      payment.refundStatus = 'PENDING_REVIEW';
      payment.refundError = `Kashier refund API returned HTTP ${response.status}`;
    }
    payment.refundHttpStatus = response.status;
    payment.refundResponse = result;
    payment.refundUpdatedAt = new Date().toISOString();
    writeStore(store);

    if (payment.refundStatus !== 'SUCCESS') {
      console.error('Automatic refund follow-up required:', payment.order, payment.refundStatus);
    }
  } catch (error) {
    // Do not blindly retry an uncertain request: the provider may already have processed it.
    payment.refundStatus = 'PENDING_REVIEW';
    payment.refundError = error.message || 'Network error while requesting refund';
    payment.refundUpdatedAt = new Date().toISOString();
    writeStore(store);
    console.error('Automatic refund request failed:', payment.order, payment.refundError);
  }
}

function verifyWebhook(data, headerSignature) {
  if (!KASHIER_API_KEY || !headerSignature || !data || !Array.isArray(data.signatureKeys)) {
    return false;
  }
  const keys = [...data.signatureKeys].sort();
  const payload = keys
    .map(key => `${key}=${encodeURIComponent(data[key] == null ? '' : String(data[key]))}`)
    .join('&');
  const digest = crypto.createHmac('sha256', KASHIER_API_KEY).update(payload).digest('hex');
  const supplied = String(headerSignature).toLowerCase();
  const expected = digest.toLowerCase();
  return expected.length === supplied.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => {
  res.set('X-SurveyQuant-Backend', 'owner-device-allowlist-v1');
  res.json({
    ok: true,
    service: 'SurveyQuant backend',
    revision: 'owner-device-allowlist-v1',
    endpoints: ['/health', '/api/config', '/api/register', '/api/status/:deviceId']
  });
});

app.get('/health', (_req, res) => {
  res.set('X-SurveyQuant-Backend', 'owner-device-allowlist-v1');
  res.json({
    ok: true,
    service: 'SurveyQuant backend',
    revision: 'owner-device-allowlist-v1',
    provider: 'Kashier',
    mode: KASHIER_MODE
  });
});

app.get('/api/config', (_req, res) => {
  res.set('X-SurveyQuant-Backend', 'owner-device-allowlist-v1');
  res.json({
    paymentProvider: 'Kashier',
    mode: KASHIER_MODE,
    trialDays: TRIAL_DAYS,
    minimumVersionCode: MINIMUM_APP_VERSION_CODE,
    latestVersionName: LATEST_APP_VERSION_NAME,
    updateUrl: UPDATE_URL,
    plans: PLANS
  });
});

app.post('/api/register', (req, res) => {
  try {
    const { deviceId, name } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId مطلوب' });

    const normalizedId = String(deviceId).trim();
    const key = `device:${normalizedId}`;
    const store = readStore();

    if (!store.users[key]) {
      store.users[key] = {
        id: crypto.randomUUID(),
        name: name || '',
        deviceId: normalizedId,
        createdAt: new Date().toISOString(),
        trialUntil: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
        activeUntil: null
      };
    } else if (name && !store.users[key].name) {
      store.users[key].name = name;
    }

    enforceTrialDuration(store.users[key]);
    writeStore(store);
    return res.json(accessPayload(store.users[key], normalizedId));
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ error: 'تعذر تسجيل الجهاز حاليًا' });
  }
});

app.get('/api/status/:deviceId', (req, res) => {
  try {
    const deviceId = decodeURIComponent(req.params.deviceId || '').trim();
    const store = readStore();
    const key = `device:${deviceId}`;
    let user = store.users[key];

    if (!user && isOwnerDevice(deviceId)) {
      user = store.users[key] = {
        id: crypto.randomUUID(),
        name: '',
        deviceId,
        createdAt: new Date().toISOString(),
        trialUntil: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
        activeUntil: null
      };
    }
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    enforceTrialDuration(user);
    writeStore(store);
    return res.json(accessPayload(user, deviceId));
  } catch (error) {
    console.error('Status error:', error);
    return res.status(500).json({ error: 'تعذرت قراءة حالة الاشتراك حاليًا' });
  }
});

app.post('/api/kashier/create-session', async (req, res) => {
  try {
    const { deviceId, plan } = req.body || {};
    const normalizedId = String(deviceId || '').trim();
    const selectedPlan = PLANS[plan];

    if (!normalizedId || !selectedPlan) {
      return res.status(400).json({ error: 'بيانات الحساب أو الباقة غير صحيحة' });
    }

    if (isOwnerDevice(normalizedId)) {
      return res.json({
        ok: true,
        ownerExempt: true,
        trialActive: true,
        subscriptionActive: true,
        activeUntil: OWNER_ACCESS_UNTIL
      });
    }

    requireKashierConfig();
    const key = `device:${normalizedId}`;
    const store = readStore();

    if (!store.users[key]) {
      store.users[key] = {
        id: crypto.randomUUID(),
        name: '',
        deviceId: normalizedId,
        createdAt: new Date().toISOString(),
        trialUntil: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
        activeUntil: null
      };
    }
    enforceTrialDuration(store.users[key]);

    const order = `SQ-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    store.payments[order] = {
      order,
      deviceId: normalizedId,
      name: store.users[key].name || '',
      plan,
      amount: selectedPlan.amount,
      currency: 'EGP',
      status: 'CREATED',
      createdAt: new Date().toISOString(),
      transactionId: null,
      subscriptionActivated: false
    };
    writeStore(store);

    const expireAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const paymentBody = {
      expireAt,
      maxFailureAttempts: 3,
      paymentType: 'credit',
      amount: selectedPlan.amount.toFixed(2),
      currency: 'EGP',
      order,
      merchantRedirect: encodeURI(`${PUBLIC_BASE_URL}/api/kashier/return?order=${encodeURIComponent(order)}`),
      display: 'ar',
      type: 'one-time',
      allowedMethods: 'card,wallet',
      redirectMethod: null,
      merchantId: KASHIER_MID,
      failureRedirect: false,
      brandColor: '#0b7d58',
      defaultMethod: 'card',
      description: `SurveyQuant ${selectedPlan.label} subscription`,
      manualCapture: false,
      customer: { reference: store.users[key].id },
      enable3DS: true,
      serverWebhook: `${PUBLIC_BASE_URL}/api/kashier/webhook`
    };

    const response = await fetch(`${KASHIER_API_BASE}/v3/payment/sessions`, {
      method: 'POST',
      headers: {
        Authorization: KASHIER_SECRET_KEY,
        'api-key': KASHIER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentBody)
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.sessionUrl) {
      return res.status(502).json({
        error: result.message || result.error || 'تعذر إنشاء جلسة الدفع من Kashier',
        details: result
      });
    }

    store.payments[order].sessionId = result._id || null;
    store.payments[order].sessionUrl = result.sessionUrl;
    writeStore(store);
    return res.json({ ok: true, order, sessionUrl: result.sessionUrl, amount: selectedPlan.amount, currency: 'EGP' });
  } catch (error) {
    console.error('Create-session error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'خطأ في إنشاء الدفع' });
  }
});

app.get('/api/kashier/status', (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '').trim();
    const order = String(req.query.order || '').trim();

    if (isOwnerDevice(deviceId)) {
      return res.json({
        paymentStatus: 'OWNER_EXEMPT',
        ownerExempt: true,
        subscriptionActive: true,
        activeUntil: OWNER_ACCESS_UNTIL
      });
    }

    const store = readStore();
    const payment = store.payments[order];
    const user = store.users[`device:${deviceId}`];
    if (!payment || !user || payment.deviceId !== deviceId) {
      return res.status(404).json({ error: 'عملية الدفع غير موجودة' });
    }

    const now = Date.now();
    return res.json({
      paymentStatus: payment.status,
      transactionId: payment.transactionId || null,
      subscriptionActive: Boolean(user.activeUntil && new Date(user.activeUntil).getTime() > now),
      activeUntil: user.activeUntil || null
    });
  } catch (error) {
    console.error('Payment status error:', error);
    return res.status(500).json({ error: 'تعذرت قراءة حالة الدفع حاليًا' });
  }
});

app.post('/api/kashier/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || {};
    const signature = req.get('x-kashier-signature');
    if (!verifyWebhook(data, signature)) return res.status(401).send('invalid signature');

    const eventId = data.transactionId ||
      `${body.event || 'event'}:${data.merchantOrderId || data.orderReference || ''}:${data.status || ''}`;
    const store = readStore();
    if (store.webhookEvents[eventId]) return res.status(200).send('Already processed');

    const order = data.merchantOrderId || data.orderReference || '';
    const payment = store.payments[order];
    let needsRefund = false;
    if (payment) {
      payment.status = data.status || 'UNKNOWN';
      payment.transactionId = data.transactionId || payment.transactionId || null;
      payment.kashierOrderId = data.kashierOrderId || payment.kashierOrderId || null;
      payment.method = data.method || data.paymentMethod || payment.method || null;
      payment.webhookAt = new Date().toISOString();

      if (data.status === 'SUCCESS' && !payment.subscriptionActivated) {
        const user = store.users[`device:${payment.deviceId}`];
        const selectedPlan = PLANS[payment.plan];
        if (user && selectedPlan) {
          const currentEnd = user.activeUntil ? new Date(user.activeUntil).getTime() : 0;
          const base = currentEnd > Date.now() ? currentEnd : Date.now();
          user.activeUntil = new Date(base + selectedPlan.days * 86400000).toISOString();
          payment.subscriptionActivated = true;
          payment.activatedAt = new Date().toISOString();
          payment.activationError = null;
        } else {
          payment.activationError = !user ? 'User record missing after successful payment' : 'Subscription plan missing or invalid';
          needsRefund = true;
          console.error('Payment activation failed; automatic refund will be requested:', order, payment.activationError);
        }
      }
    } else if (data.status === 'SUCCESS' && String(order).startsWith('SQ-')) {
      store.unmatchedSuccessfulPayments = store.unmatchedSuccessfulPayments || {};
      store.unmatchedSuccessfulPayments[eventId] = {
        order,
        kashierOrderId: data.kashierOrderId || null,
        transactionId: data.transactionId || null,
        status: data.status,
        receivedAt: new Date().toISOString(),
        action: 'Manual review required: local payment record missing'
      };
      console.error('No local record for successful payment:', order);
    }

    store.webhookEvents[eventId] = new Date().toISOString();
    writeStore(store);

    if (payment && needsRefund) {
      await requestAutomaticRefund(store, payment, data, payment.activationError || 'Subscription activation failed');
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).send('Webhook processing error');
  }
});

app.get('/api/kashier/return', (_req, res) => {
  res.status(200).send(`<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SurveyQuant</title></head>
<body style="font-family:Arial;text-align:center;padding:40px">
<h2>تمت العودة من صفحة الدفع</h2>
<p>ارجع إلى تطبيق مكتب فني مساحة. يتم التفعيل بعد تأكيد عملية الدفع من Kashier.</p>
<p>يمكنك إغلاق هذه الصفحة.</p>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`SurveyQuant Kashier backend on :${PORT} (${KASHIER_MODE})`);
});
