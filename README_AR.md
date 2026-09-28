# SurveyQuant Manual Payment Backend

دفع يدوي فقط بدون MyFatoorah وبدون Webhook.

رقم التحويل الافتراضي: 01118980717

## التشغيل
npm install
npm start

ثم اجعل API_BASE_URL في التطبيق عنوان السيرفر المنشور، مثال:
https://YOUR-DOMAIN/api

## الوظائف
- تجربة مجانية 7 أيام.
- محفظة إلكترونية أو InstaPay.
- رفع إيصال التحويل + رقم العملية.
- لوحة API للإدارة لقبول/رفض الطلب.
- قبول الطلب يفعّل الاشتراك لمدة 30 يومًا افتراضيًا.

غيّر PAYMENT_NUMBER وPORT عبر Environment Variables عند النشر.
