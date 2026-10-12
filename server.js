const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Persistent Railway Volume storage
const DATA_DIR = process.env.SURVEYQUANT_DATA_DIR || '/app/data';
const DATA = path.join(DATA_DIR, 'data.json');

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

// Only exact device IDs listed in Railway's
// SURVEYQUANT_OWNER_DEVICE_IDS are exempt.
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

// Create the persistent directory before reading or writing data.
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DATA)) {
  fs.writeFileSync(
    DATA,
    JSON.stringify(
      { users: {}, payments: {}, webhookEvents: {} },
      null,
      2
    )
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
    user.trial
