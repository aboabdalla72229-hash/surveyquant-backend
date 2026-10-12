const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA = path.join(__dirname, 'data.json');

const KASHIER_MODE =
  (process.env.KASHIER_MODE || 'test').toLowerCase() === 'live'
    ? 'live'
    : 'test';

const KASHIER_API_BASE =
  KASHIER_MODE === 'live'
    ? 'https://api.kashier.io'
    : 'https://test-api.kashier.io';

const KASHIER_API_KEY = process.env.KASHIER_API_KEY || '';
const KASHIER_SECRET_KEY = process.env.KASHIER_SECRET_KEY || '';
const KASHIER_MID = process.env.KASHIER_MID || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const TRIAL_DAYS = 3;
// Only exact device IDs listed in Railway's SURVEYQUANT_OWNER_DEVICE_IDS are exempt.
const OWNER_DEVICE_IDS = new Set(
  (process.env.SURVEYQUANT_OWNER_DEVICE_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const OWNER_ACCESS_UNTIL = '2099-12-31T23:59:59.000Z';

function isOwnerDevice(deviceId) {
  return OWNER_DEVICE_IDS.has(String(deviceId || '').trim());
}

function accessPayload(user, deviceId) {
  const ownerExempt = isOwnerDevice(deviceId);
  const now = Date.now();
  return {
    ...user,
    ownerExempt,
    trialActive:
      ownerExempt ||
      (!!user.trialUntil && new Date(user.trialUntil).getTime() > now),
    subscriptionActive:
      ownerExempt ||
      (!!user.activeUntil && new Date(user.activeUntil).getTime() > now),
    trialUntil: ownerExempt ? OWNER_ACCESS_UNTIL : user.trialUntil,
    activeUntil: ownerExempt ? OWNER_ACCESS_UNTIL : user.activeUntil
  };
}
const MINIMUM_APP_VERSION_CODE =
  Number(process.env.MINIMUM_APP_VERSION_CODE || 93);
const LATEST_APP_VERSION_NAME =
  process.env.LATEST_APP_VERSION_NAME || '1.0.93';
const UPDATE_URL =
  process.env.UPDATE_URL ||
  'https://github.com/aboabdalla72229-hash/SurveyQuantAndroid_v1.0.57/releases/download/v1.0.93/SurveyQuant_v1.0.93.apk';

const PLANS = {
  monthly: { amount: 55, days: 30, label: 'شهري' },
  quarterly: { amount: 150, days: 90, label: '3 شهور' },
  yearly: { amount: 500, days: 365, label: 'سنوي' }
};

if (!fs.existsSync(DATA)) {
  fs.writeFileSync(
    DATA,
    JSON.stringify({ users: {}, payments: {}, webhookEvents: {} }, null, 2)
  );
}

const read = () => JSON.parse(fs.readFileSync(DATA, 'utf8'));

const write = data =>
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2));

function enforceTrialDuration(user) {
  if (!user || !user.createdAt) return;

  const cap = new Date(
    new Date(user.createdAt).getTime() + TRIAL_DAYS * 86400000
  );

  const current = user.trialUntil
    ? new Date(user.trialUntil)
    : cap;

  if (!user.trialUntil || current.getTime() > cap.getTime()) {
    user.trialUntil = cap.toISOString();
  }
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

app.get('/api/config', (req, res) => {
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
  const { deviceId, name } = req.body || {};

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId مطلوب' });
  }

  const normalizedId = String(deviceId).trim();
  const key = 'device:' + normalizedId;
  const data = read();

  if (!data.users[key]) {
    data.users[key] = {
      id: crypto.randomUUID(),
      name: name || '',
      deviceId: normalizedId,
      createdAt: new Date().toISOString(),
      trialUntil: new Date(
        Date.now() + TRIAL_DAYS * 86400000
      ).toISOString(),
      activeUntil: null
    };
  } else if (name && !data.users[key].name) {
    data.users[key].name = name;
  }

  enforceTrialDuration(data.users[key]);
  write(data);
  res.json(accessPayload(data.users[key], normalizedId));
});

app.get('/api/status/:deviceId', (req, res) => {
  const data = read();
  const deviceId = decodeURIComponent(req.params.deviceId);
  const key = 'device:' + deviceId;
  let user = data.users[key];

  if (!user && isOwnerDevice(deviceId)) {
    user = data.users[key] = {
      id: crypto.randomUUID(),
      name: '',
      deviceId,
      createdAt: new Date().toISOString(),
      trialUntil: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
      activeUntil: null
    };
  }

  if (!user) {
    return res.status(404).json({ error: 'المستخدم غير موجود' });
  }

  enforceTrialDuration(user);
  write(data);
  res.json(accessPayload(user, deviceId));
});

function requireKashierConfig() {
  if (
    !KASHIER_API_KEY ||
    !KASHIER_SECRET_KEY ||
    !KASHIER_MID ||
    !PUBLIC_BASE_URL
  ) {
    const error = new Error(
      'لم يتم إعداد مفاتيح Kashier أو PUBLIC_BASE_URL على السيرفر بعد'
    );
    error.statusCode = 503;
    throw error;
  }
}
app.post('/api/kashier/create-session', async (req, res) => {
  try {
    const { deviceId, plan } = req.body || {};
    const normalizedId = String(deviceId || '').trim();
    const key = 'device:' + normalizedId;
    const selectedPlan = PLANS[plan];

    if (!normalizedId || !selectedPlan) {
      return res.status(400).json({
        error: 'بيانات الحساب أو الباقة غير صحيحة'
      });
    }

    if (isOwnerDevice(normalizedId)) {
      return res.status(403).json({
        error: 'هذا الجهاز مستثنى من الاشتراك والدفع',
        ownerExempt: true,
        trialActive: true,
        subscriptionActive: true,
        activeUntil: OWNER_ACCESS_UNTIL
      });
    }

    requireKashierConfig();
    const data = read();

    if (!data.users[key]) {
      data.users[key] = {
        id: crypto.randomUUID(),
        deviceId: normalizedId,
        name: '',
        createdAt: new Date().toISOString(),
        trialUntil: new Date(
          Date.now() + TRIAL_DAYS * 86400000
        ).toISOString(),
        activeUntil: null
      };
    }

    enforceTrialDuration(data.users[key]);

    const order =
      `SQ-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    data.payments[order] = {
      order,
      deviceId: normalizedId,
      name: data.users[key].name || '',
      plan,
      amount: selectedPlan.amount,
      currency: 'EGP',
      status: 'CREATED',
      createdAt: new Date().toISOString(),
      transactionId: null
    };

    write(data);

    const expireAt = new Date(
      Date.now() + 30 * 60 * 1000
    ).toISOString();

    const paymentBody = {
      expireAt,
      maxFailureAttempts: 3,
      paymentType: 'credit',
      amount: selectedPlan.amount.toFixed(2),
      currency: 'EGP',
      order,
      merchantRedirect:
        encodeURI(
          `${PUBLIC_BASE_URL}/api/kashier/return?order=${encodeURIComponent(order)}`
        ),
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
      customer: { reference: data.users[key].id },
      enable3DS: true,
      serverWebhook: `${PUBLIC_BASE_URL}/api/kashier/webhook`
    };

    const response = await fetch(
      `${KASHIER_API_BASE}/v3/payment/sessions`,
      {
        method: 'POST',
        headers: {
          Authorization: KASHIER_SECRET_KEY,
          'api-key': KASHIER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(paymentBody)
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.sessionUrl) {
      return res.status(502).json({
        error:
          result.message ||
          result.error ||
          'تعذر إنشاء جلسة الدفع من Kashier',
        details: result
      });
    }

    data.payments[order].sessionId = result._id || null;
    data.payments[order].sessionUrl = result.sessionUrl;
    write(data);

    res.json({
      ok: true,
      order,
      sessionUrl: result.sessionUrl,
      amount: selectedPlan.amount,
      currency: 'EGP'
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message || 'خطأ في إنشاء الدفع'
    });
  }
});

app.get('/api/kashier/status', (req, res) => {
  const deviceId = String(req.query.deviceId || '').trim();
  const order = String(req.query.order || '').trim();

  if (isOwnerDevice(deviceId)) {
    return res.json({
      paymentStatus: 'OWNER_EXEMPT',
      transactionId: null,
      subscriptionActive: true,
      ownerExempt: true,
      activeUntil: OWNER_ACCESS_UNTIL
    });
  }

  const data = read();
  const payment = data.payments[order];
  const user = data.users['device:' + deviceId];

  if (!payment || !user || payment.deviceId !== deviceId) {
    return res.status(404).json({
      error: 'عملية الدفع غير موجودة'
    });
  }

  const now = Date.now();

  res.json({
    paymentStatus: payment.status,
    transactionId: payment.transactionId,
    subscriptionActive:
      !!user.activeUntil && new Date(user.activeUntil).getTime() > now,
    activeUntil: user.activeUntil || null
  });
});

function verifyWebhook(data, headerSignature) {
  if (
    !KASHIER_API_KEY ||
    !headerSignature ||
    !data ||
    !Array.isArray(data.signatureKeys)
  ) {
    return false;
  }

  const keys = [...data.signatureKeys].sort();

  const payload = keys
    .map(
      key =>
        `${key}=${encodeURIComponent(
          data[key] == null ? '' : String(data[key])
        )}`
    )
    .join('&');

  const digest = crypto
    .createHmac('sha256', KASHIER_API_KEY)
    .update(payload)
    .digest('hex');

  const supplied = String(headerSignature).toLowerCase();
  const expected = digest.toLowerCase();

  return (
    expected.length === supplied.length &&
    crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(supplied)
    )
  );
}
app.post('/api/kashier/webhook', (req, res) => {
  const body = req.body || {};
  const data = body.data || {};
  const signature = req.get('x-kashier-signature');

  if (!verifyWebhook(data, signature)) {
    return res.status(401).send('invalid signature');
  }

  const eventId =
    data.transactionId ||
    `${body.event || 'event'}:${data.merchantOrderId || data.orderReference || ''}:${data.status || ''}`;

  const store = read();

  store.webhookEvents = store.webhookEvents || {};

  if (store.webhookEvents[eventId]) {
    return res.status(200).send('Already processed');
  }

  const order = data.merchantOrderId || data.orderReference || '';
  const payment = store.payments[order];

  if (payment) {
    payment.status = data.status || 'UNKNOWN';
    payment.transactionId = data.transactionId || null;
    payment.kashierOrderId = data.kashierOrderId || null;
    payment.method = data.method || data.paymentMethod || null;
    payment.webhookAt = new Date().toISOString();

    if (data.status === 'SUCCESS' && !payment.subscriptionActivated) {
      const user = store.users['device:' + payment.deviceId];
      const plan = PLANS[payment.plan];

      if (user && plan) {
        const activeUntil = user.activeUntil
          ? new Date(user.activeUntil).getTime()
          : 0;

        const base =
          activeUntil > Date.now() ? activeUntil : Date.now();

        user.activeUntil = new Date(
          base + plan.days * 86400000
        ).toISOString();

        payment.subscriptionActivated = true;
      }
    }
  }

  store.webhookEvents[eventId] = new Date().toISOString();
  write(store);

  return res.status(200).send('OK');
});

app.get('/api/kashier/return', (req, res) => {
  res.status(200).send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SurveyQuant</title>
</head>
<body style="font-family:Arial;text-align:center;padding:40px">
<h2>تمت العودة من صفحة الدفع</h2>
<p>ارجع إلى تطبيق مكتب فني مساحة. يتم التفعيل بعد تأكيد عملية الدفع من Kashier.</p>
<p>يمكنك إغلاق هذه الصفحة.</p>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.set('X-SurveyQuant-Backend', 'owner-device-allowlist-v1');
  res.json({
    ok: true,
    service: 'SurveyQuant backend',
    revision: 'owner-device-allowlist-v1',
    provider: 'Kashier',
    mode: KASHIER_MODE
  });
});

app.listen(PORT, () => {
  console.log(
    `SurveyQuant Kashier backend on :${PORT} (${KASHIER_MODE})`
  );
});
