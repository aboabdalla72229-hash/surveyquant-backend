const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// التخزين الدائم: قم بتعيين مسار تركيب وحدة تخزين السكك الحديدية إلى /app/data.
const DATA_DIR = process.env.SURVEYQUANT_DATA_DIR || '/app/data';
const DATA = path.join(DATA_DIR, 'data.json');

const KASHIER_MODE =
  (process.env.KASHIER_MODE || 'test').toLowerCase() === 'live'
    ؟ 'يعيش'
    : 'امتحان'؛

const KASHIER_API_BASE =
  KASHIER_MODE === 'live'
    ؟ 'https://api.kashier.io'
    : 'https://test-api.kashier.io';

// تستخدم عمليات استرداد الأموال نقطة نهاية Kashier FEP منفصلة عن إنشاء جلسة الدفع.
const KASHIER_REFUND_API_BASE =
  KASHIER_MODE === 'live'
    ؟ 'https://fep.kashier.io'
    : 'https://test-fep.kashier.io';

const KASHIER_API_KEY = process.env.KASHIER_API_KEY || '';
const KASHIER_SECRET_KEY = process.env.KASHIER_SECRET_KEY || '';
const KASHIER_MID = process.env.KASHIER_MID || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const TRIAL_DAYS = 3;

// استثنِ فقط معرّفات الأجهزة المحددة التي تم تكوينها في Railway.
const OWNER_DEVICE_IDS = new Set(
  (process.env.SURVEYQUANT_OWNER_DEVICE_IDS || '')
    .ينقسم('،')
    .map(value => value.trim())
    .filter(Boolean)
);
const OWNER_ACCESS_UNTIL = '2099-12-31T23:59:59.000Z';

دالة isOwnerDevice(deviceId) {
  return OWNER_DEVICE_IDS.has(String(deviceId || '').trim());
}

دالة الوصول إلى الحمولة (المستخدم، معرف الجهاز) {
  const ownerExempt = isOwnerDevice(deviceId);
  const now = Date.now();
  يعود {
    ...مستخدم،
    المالك المعفى،
    تجريبي نشط:
      ownerExempt || (!!user.trialUntil && new Date(user.trialUntil).getTime() > now),
    الاشتراك نشط:
      ownerExempt || (!!user.activeUntil && new Date(user.activeUntil).getTime() > now),
    trialUntil: ownerExempt ? OWNER_ACCESS_UNTIL : user.trialUntil,
    activeUntil: ownerExempt ? OWNER_ACCESS_UNTIL : user.activeUntil
  };
}

const MINIMUM_APP_VERSION_CODE = Number(process.env.MINIMUM_APP_VERSION_CODE || 93);
const LATEST_APP_VERSION_NAME = process.env.LATEST_APP_VERSION_NAME || '1.0.93';
const UPDATE_URL =
  process.env.UPDATE_URL ||
  'https://github.com/aboabdalla72229-hash/SurveyQuantAndroid_v1.0.57/releases/download/v1.0.93/SurveyQuant_v1.0.93.apk';

const PLANS = {
  شهريًا: { المبلغ: 55، الأيام: 30، التسمية: 'ط´ظ‡ط±ظٹ' },
  ربع سنوي: { المبلغ: 150، الأيام: 90، التسمية: '3 ط´ظ‡ظˆط±' },
  سنويًا: { المبلغ: 500، الأيام: 365، التصنيف: 'ط³ظ†ظˆظٹ' }
};

// تأكد من وجود الدليل الدائم وملف JSON الأولي قبل وصول الطلبات.
fs.mkdirSync(DATA_DIR, { recursive: true });
إذا لم تكن البيانات متزامنة في نظام الملفات (fs.existsSync(DATA)) {
  fs.writeFileSync(
    بيانات،
    JSON.stringify({ users: {}, payments: {}, webhookEvents: {} }, null, 2),
    'utf8'
  );
}

const read = () => JSON.parse(fs.readFileSync(DATA, 'utf8'));
const write = data => fs.writeFileSync(DATA, JSON.stringify(data, null, 2), 'utf8');

دالة فرض مدة التجربة (المستخدم) {
  إذا لم يكن المستخدم موجودًا أو لم يتم إنشاؤه في تاريخ محدد، فقم بالخروج.
  const cap = new Date(new Date(user.createdAt).getTime() + TRIAL_DAYS * 86400000);
  const current = user.trialUntil ? new Date(user.trialUntil) : cap;
  إذا لم يكن لدى المستخدم وقت تجريبي محدد أو كان الوقت الحالي أكبر من الوقت المحدد، {
    user.trialUntil = cap.toISOString();
  }
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'SurveyQuant backend' });
});

app.get('/api/config', (req, res) => {
  res.json({
    موفر الدفع: 'كاشير'
    الوضع: KASHIER_MODE،
    أيام المحاكمة: أيام_المحاكمة،
    minimumVersionCode: MINIMUM_APP_VERSION_CODE,
    اسم أحدث إصدار: LATEST_APP_VERSION_NAME,
    updateUrl: UPDATE_URL,
    الخطط: الخطط
  });
});

app.post('/api/register', (req, res) => {
  يحاول {
    const { deviceId, name } = req.body || {};
    إذا لم يكن معرف الجهاز موجودًا {
      return res.status(400).json({ error: 'deviceId ظ…ط·ظ„ظˆط¨' });
    }

    const normalizedId = String(deviceId).trim();
    const key = 'device:' + normalizedId;
    const data = read();

    إذا لم يكن المستخدمون موجودين في البيانات [المفتاح] {
      data.users[key] = {
        المعرّف: crypto.randomUUID(),
        الاسم: الاسم || '',
        معرّف الجهاز: المعرّف المُعَيَّر،
        تاريخ الإنشاء: تاريخ جديد().toISOString(),
        trialUntil: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
        نشط حتى: لا شيء
      };
    } else if (name && !data.users[key].name) {
      data.users[key].name = name;
    }

    enforceTrialDuration(data.users[key]);
    اكتب(البيانات)؛
    return res.json(accessPayload(data.users[key], normalizedId));
  } catch (error) {
    console.error('خطأ في التسجيل:', error);
    return res.status(500).json({ error: 'طھط¹ط°ط± طھط³ط¬ظٹظ‹ ط§ظ‹ط¬ظ‡ط§ط² طط§ظ‹ظٹظ‹ط§' });
  }
});

app.get('/api/status/:deviceId', (req, res) => {
  يحاول {
    const deviceId = decodeURIComponent(req.params.deviceId || '').trim();
    const data = read();
    const user = data.users['device:' + deviceId];
    إذا لم يكن هناك مستخدم {
      return res.status(404).json({ error: 'ط§ظ„ظ…ط³طھط®ط¯ظ… ط؛ظٹط± ظ…ظˆط¬ظˆط¯' });
    }
    فرض مدة التجربة (المستخدم)؛
    اكتب(البيانات)؛
    return res.json(accessPayload(user, deviceId));
  } catch (error) {
    console.error('خطأ في الحالة:', error);
    return res.status(500).json({ error: 'طھط¹ط°ط± ظ‚ط±ط§ط،ط© طط§ظ„ط© ط§ظ„ط§ط´طھط±ط§ظƒ طط§ظ„ظٹظ‹ط§' });
  }
});

دالة تتطلب إعدادات كاشير () {
  إذا لم يكن مفتاح واجهة برمجة تطبيقات كاشير (KASHIER_API_KEY) أو مفتاح كاشير السري (KASHIER_SECRET_KEY) أو معرّف كاشير (KASHIER_MID) أو عنوان URL لقاعدة البيانات العامة (PUBLIC_BASE_URL) {
    const error = new Error('ظ„ظ… ظٹطھ… ط¥ط¹ط¯ط§ط¯ ظ…ظپط§طھظٹط كاشير ط £ظˆ PUBLIC_BASE_URL ط¹ظ„ظ‰ ط§ظ„ط³ظٹط±ظپط± ط¨ط¹ط¯');
    error.statusCode = 503;
    أسقط خطأً؛
  }
}

app.post('/api/kashier/create-session', async (req, res) => {
  يحاول {
    const { deviceId, plan } = req.body || {};
    const normalizedId = String(deviceId || '').trim();
    const selectedPlan = PLANS[plan];
    إذا لم يتم تطبيق المعرف الموحد أو لم يتم تحديد الخطة، {
      return res.status(400)
    }

    // ينطبق هذا الاستثناء فقط على معرف (معرفات) جهاز المالك المُكوّن بشكل صريح.
    إذا كان الجهاز هو الجهاز المالك (normalizedId)) {
      return res.json({
        حسناً: صحيح،
        ownerExempt: true,
        subscriptionActive: true,
        نشط حتى: وصول المالك حتى
      });
    }

    requireKashierConfig();
    const key = 'device:' + normalizedId;
    const data = read();

    إذا لم يكن المستخدمون موجودين في البيانات [المفتاح] {
      data.users[key] = {
        المعرّف: crypto.randomUUID(),
        معرّف الجهاز: المعرّف المُعَيَّر،
        اسم: ''،
        تاريخ الإنشاء: تاريخ جديد().toISOString(),
        trialUntil: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
        نشط حتى: لا شيء
      };
    }
    enforceTrialDuration(data.users[key]);

    const order = `SQ-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    data.payments[order] = {
      طلب،
      معرّف الجهاز: المعرّف المُعَيَّر،
      الاسم: data.users[key].name || '',
      يخطط،
      المبلغ: المبلغ المحدد في الخطة،
      العملة: الجنيه المصري
      الحالة: 'تم الإنشاء'،
      تاريخ الإنشاء: تاريخ جديد().toISOString(),
      معرف المعاملة: لا شيء،
      تم تفعيل الاشتراك: خطأ
    };
    اكتب(البيانات)؛

    const expireAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const paymentBody = {
      تاريخ انتهاء الصلاحية،
      الحد الأقصى لمحاولات الفشل: 3
      نوع الدفع: "ائتمان"،
      المبلغ: selectedPlan.amount.toFixed(2)،
      العملة: الجنيه المصري
      طلب،
      merchantRedirect: encodeURI(
        `${PUBLIC_BASE_URL}/api/kashier/return?order=${encodeURIComponent(order)}`
      )
      العرض: 'ar',
      النوع: "مرة واحدة"،
      الطرق المسموح بها: 'card,wallet',
      redirectMethod: null,
      معرّف التاجر: KASHIER_MID،
      failureRedirect: false,
      لون العلامة التجارية: '#0b7d58'،
      الطريقة الافتراضية: 'card'،
      الوصف: `اشتراك SurveyQuant ${selectedPlan.label}`,
      الالتقاط اليدوي: خطأ،
      العميل: { المرجع: data.users[key].id },
      enable3DS: true,
      رابط الخادم: `${PUBLIC_BASE_URL}/api/kashier/webhook`
    };

    const response = await fetch(`${KASHIER_API_BASE}/v3/payment/sessions`, {
      الطريقة: 'POST'
      الرؤوس: {
        رقم التفويض: KASHIER_SECRET_KEY،
        'api-key': KASHIER_API_KEY,
        نوع المحتوى: تطبيق/json
      },
      نص الدفع: JSON.stringify(paymentBody)
    });
    const result = await response.json().catch(() => ({}));
    إذا لم تكن الاستجابة ناجحة (response.ok) أو لم يكن عنوان URL للجلسة موجودًا (result.sessionUrl)، {
      return res.status(502).json({
        خطأ: result.message || نتيجة.خطأ || 'طھط¹ط°ط± ط¥ظ†ط´ط§ط، ط¬ظ„ط³ط© ط§ظ„ط¯ظپط¹ ظ…ظ† كاشير',
        التفاصيل: النتيجة
      });
    }

    data.payments[order].sessionId = result._id || null;
    data.payments[order].sessionUrl = result.sessionUrl;
    اكتب(البيانات)؛
    return res.json({
      حسناً: صحيح،
      طلب،
      sessionUrl: result.sessionUrl,
      المبلغ: المبلغ المحدد في الخطة،
      العملة: الجنيه المصري
    });
  } catch (error) {
    console.error('خطأ في إنشاء الجلسة:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'ط®ط·ط £ ظپظٹ ط¥ظ†ط´ط§ط، ط§ظ„ط¯ظپط¹' });
  }
});

app.get('/api/kashier/status', (req, res) => {
  يحاول {
    const deviceId = String(req.query.deviceId || '').trim();
    const order = String(req.query.order || '').trim();
    إذا كان الجهاز هو الجهاز المالك (معرف الجهاز) {
      return res.json({
        ownerExempt: true,
        حالة الدفع: 'معفى من الدفع'،
        subscriptionActive: true,
        نشط حتى: وصول المالك حتى
      });
    }

    const data = read();
    const payment = data.payments[order];
    const user = data.users['device:' + deviceId];
    إذا لم يتم الدفع أو لم يكن هناك مستخدم أو لم يكن معرف الجهاز الخاص بالدفع مطابقًا لمعرف الجهاز، {
      return res.status(404).json({ error: 'ط¹ظ…ظ„ظٹط© ط§ظ„ط¯ظپط¹ ط؛ظٹط± ظ…ظˆط¬ظˆط¯ط©' });
    }
    const now = Date.now();
    return res.json({
      حالة الدفع: payment.status,
      معرف المعاملة: payment.transactionId,
      subscriptionActive: !!user.activeUntil && new Date(user.activeUntil).getTime() > now,
      activeUntil: user.activeUntil || null
    });
  } catch (error) {
    console.error('خطأ في حالة الدفع:', error);
    return res.status(500).json({ error: 'طھط¹ط°ط± ظ‚ط±ط§ط،ط© طط§ظ‹ط© ط§ظ‹ط¯ظپط¹ طط§ظ‹ظٹظ‹ط§' });
  }
});

دالة التحقق من Webhook(البيانات، توقيع الرأس) {
  إذا لم يكن مفتاح واجهة برمجة تطبيقات KASHIER موجودًا، أو لم يكن توقيع الرأس موجودًا، أو لم تكن البيانات موجودة، أو لم تكن مفاتيح التوقيع الخاصة بالبيانات عبارة عن مصفوفة، {
    أعد القيمة خطأ؛
  }
  const keys = [...data.signatureKeys].sort();
  const payload = keys
    .map(key => `${key}=${encodeURIComponent(data[key] == null ? '' : String(data[key]))}`)
    .ينضم('&')؛
  const digest = crypto.createHmac('sha256', KASHIER_API_KEY).update(payload).digest('hex');
  const provided = String(headerSignature).toLowerCase();
  const expected = digest.toLowerCase();
  return expected.length === provided.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

async function requestAutomaticRefund(store, payment, webhookData, reason) {
  // لا ترسل أبدًا طلب استرداد مكررًا دون تفكير.
  const alreadyStarted = ['REQUESTED', 'SUCCESS', 'PENDING', 'MANUAL_REVIEW_REQUIRED', 'PENDING_REVIEW']
    .includes(String(payment.refundStatus || '').toUpperCase());
  إذا (بدأ بالفعل) فارجع؛

  const providerOrderId = String(
    (بيانات webhook && بيانات webhook.kashierOrderId) || payment.kashierOrderId || ''
  ).تقليم()؛
  const transactionId = String(
    (بيانات webhook && webhookData.transactionId) || payment.transactionId || ''
  ).تقليم()؛

  payment.kashierOrderId = providerOrderId || payment.kashierOrderId || null;
  payment.refundReason = reason;
  payment.refundRequestedAt = new Date().toISOString();

  إذا لم يكن مفتاح المحاسب السري موجودًا أو لم يكن معرف طلب الموفر موجودًا،
    payment.refundStatus = 'MANUAL_REVIEW_REQUIRED';
    payment.refundError = !KASHIER_SECRET_KEY
      لم يتم تكوين مفتاح KASHIER_SECRET_KEY.
      : 'رقم تعريف طلب أمين الصندوق مفقود من سجل الويب هوك/الدفع'؛
    اكتب(خزن)؛
    console.error('تعذر إرسال رد الأموال تلقائيًا:', payment.order, payment.refundError);
    يعود؛
  }

  // احتفظ بعلامة الطلب قبل استدعاء كاشير لتقليل مخاطر الاسترداد المكرر.
  payment.refundStatus = 'REQUESTED';
  payment.refundError = null;
  اكتب(خزن)؛

  يحاول {
    const refundBody = {
      apiOperation: 'REFUND',
      السبب: "استرداد تلقائي من SurveyQuant: فشل تفعيل الاشتراك".
      transaction: transactionId ? { targetTransactionId: transactionId } : {}
    };
    const response = await fetch(
      `${KASHIER_REFUND_API_BASE}/v3/orders/${encodeURIComponent(providerOrderId)}`,
      {
        الطريقة: 'PUT'،
        الرؤوس: {
          رقم التفويض: KASHIER_SECRET_KEY،
          مقبول: 'application/json'،
          نوع المحتوى: تطبيق/json
        },
        نص الاستجابة: JSON.stringify(refundBody)
      }
    );
    const result = await response.json().catch(() => ({}));
    const providerStatus = String(
      result.status || (result.response && result.response.status) || ''
    ).toUpperCase();

    إذا كانت الاستجابة صحيحة (response.ok) وكانت حالة الموفر تتضمن ['SUCCESS', 'PENDING', 'FAILURE'] {
      payment.refundStatus = providerStatus;
    } آخر {
      payment.refundStatus = 'PENDING_REVIEW';
      payment.refundError = `Kashier refund API returned HTTP ${response.status}`;
    }
    payment.refundHttpStatus = response.status;
    payment.refundResponse = result;
    payment.refundUpdatedAt = new Date().toISOString();
    اكتب(خزن)؛

    إذا لم تكن حالة استرداد الدفعة تساوي "نجاح" {
      console.error('يحتاج رد الأموال التلقائي إلى متابعة:', payment.order, payment.refundStatus);
    }
  } catch (error) {
    // لا تقم بإعادة محاولة الطلب غير المؤكد تلقائيًا: يجب تجنب عمليات الاسترداد المكررة.
    payment.refundStatus = 'PENDING_REVIEW';
    payment.refundError = error.message || 'حدث خطأ في الشبكة أثناء طلب استرداد الأموال';
    payment.refundUpdatedAt = new Date().toISOString();
    اكتب(خزن)؛
    console.error('فشل طلب الاسترداد التلقائي:', payment.order, payment.refundError);
  }
}

app.post('/api/kashier/webhook', async (req, res) => {
  يحاول {
    const body = req.body || {};
    const data = body.data || {};
    const signature = req.get('x-kashier-signature');

    إذا لم يتم التحقق من صحة Webhook(البيانات، التوقيع) {
      return res.status(401).send('توقيع غير صالح');
    }

    const eventId = data.transactionId ||
      `${body.event || 'event'}:${data.merchantOrderId || data.orderReference || ''}:${data.status || ''}`;
    const store = read();
    store.webhookEvents = store.webhookEvents || {};

    إذا كان (store.webhookEvents[eventId]) {
      return res.status(200).send('تمت المعالجة بالفعل');
    }

    const order = data.merchantOrderId || data.orderReference || '';
    const payment = store.payments[order];
    let needsRefund = false;

    إذا (تم الدفع) {
      payment.kashierOrderId = data.kashierOrderId || payment.kashierOrderId || null;

      // التعامل مع إشعارات استرداد الأموال بشكل منفصل حتى لا تستبدل بيانات معاملات الدفع.
      إذا كان (body.event === 'refund' || body.event === 'partial_refund') {
        payment.refundStatus = String(data.status || 'UNKNOWN').toUpperCase();
        payment.refundTransactionId = data.transactionId || payment.refundTransactionId || null;
        payment.refundWebhookAt = new Date().toISOString();
      } آخر {
        payment.status = data.status || 'UNKNOWN';
        payment.transactionId = data.transactionId || payment.transactionId || null;
        payment.kashierOrderId = data.kashierOrderId || payment.kashierOrderId || null;
        payment.method = data.method || data.paymentMethod || payment.method || null;
        payment.webhookAt = new Date().toISOString();

        إذا كانت حالة البيانات تساوي 'نجاح' ولم يتم تفعيل الاشتراك في الدفع، {
          const user = store.users['device:' + payment.deviceId];
          const plan = PLANS[payment.plan];

          إذا كان (المستخدم && الخطة) {
            const activeUntil = user.activeUntil ? new Date(user.activeUntil).getTime() : 0;
            const base = activeUntil > Date.now() ? activeUntil : Date.now();
            user.activeUntil = new Date(base + plan.days * 86400000).toISOString();
            payment.subscriptionActivated = true;
            payment.activatedAt = new Date().toISOString();
            payment.activationError = null;
          } آخر {
            // تم الدفع بنجاح ولكن لا يوجد مستخدم/خطة محلية صالحة للتفعيل.
            payment.activationError = !user ? 'لم يتم العثور على سجل المستخدم بعد إتمام عملية الدفع بنجاح' : 'خطة الاشتراك مفقودة أو غير صالحة';
            needsRefund = true;
          }
        }
      }
    } else if (data.status === 'SUCCESS' && String(order).startsWith('SQ-')) {
      // الطلب ينتمي إلى مساحة اسم هذا التطبيق، ولكن سجل الدفع المحلي الخاص به مفقود.
      // احتفظ بسجل تدقيق؛ بدون السجل المحلي الأصلي، يتم توجيه العملية إلى مراجعة يدوية.
      store.unmatchedSuccessfulPayments = store.unmatchedSuccessfulPayments || {};
      store.unmatchedSuccessfulPayments[eventId] = {
        طلب،
        kashierOrderId: data.kashierOrderId || null,
        معرف المعاملة: data.transactionId || null,
        الحالة: بيانات الحالة،
        receivedAt: new Date().toISOString(),
        الإجراء: 'المراجعة اليدوية مطلوبة: سجل الدفع المحلي مفقود'
      };
      console.error('لا يوجد سجل محلي للدفعة الناجحة:', order);
    }

    store.webhookEvents[eventId] = new Date().toISOString();
    اكتب(خزن)؛

    إذا (تم الدفع و) كان هناك حاجة إلى استرداد المبلغ) {
      انتظر طلب الاسترداد التلقائي (المتجر، الدفع، البيانات، خطأ التفعيل).
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('خطأ في webhook:', error);
    return res.status(500).send('خطأ في معالجة webhook');
  }
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
<h2>طھظ…طھ ط§ظ„ط¹ظˆط¯ط© ظ…ظ† طμظپطط© ط§ظ„ط¯ظپط¹</h2>
<p>ط§ط±ط¬ط¹ ط¥ظ„ظ‰ طھط·ط¨ظٹظ‚ ظ…ظƒطھط¨ ظپظ†ظٹ ظ…ط³ط§طط©. ط¹ظ…ظ„ظٹط© ط§ظ„ط¯ظپط¹ ظ…ظ† كاشير.</p>
<p>ظٹظ…ظƒظ†ظƒ ط¥ط;ظ„ط§ظ‚ ظ‡ط°ظ‡ ط§ظ„طμظپطط©.</p>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({
    حسناً: صحيح،
    الخدمة: 'SurveyQuant backend',
    مراجعة: 'owner-device-allowlist-v1'،
    المزوّد: 'كاشير'
    الوضع: وضع الكاشير
  });
});

app.listen(PORT, () => {
  console.log(`SurveyQuant Kashier backend on :${PORT} (${KASHIER_MODE})`);
});
