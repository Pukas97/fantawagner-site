// netlify/functions/notify.js
const { GoogleAuth } = require('google-auth-library');
const https = require('https');

const PROJECT_ID = 'fanta-wagner';
const RTDB_URL   = 'https://fanta-wagner-default-rtdb.europe-west1.firebasedatabase.app';

function getServiceAccountFromEnv(){
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT non impostata');
  try { return JSON.parse(raw); }
  catch {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(decoded);
  }
}

async function getAccessToken(){
  const sa = getServiceAccountFromEnv();
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging']
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error('Access token non ottenuto');
  return token.token;
}

function fetchAllTokensFromRTDB(){
  return new Promise((resolve, reject) => {
    https.get(`${RTDB_URL}/tokens.json`, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try{
          const val = JSON.parse(String(data||'null')) || {};
          const tokens = Object.values(val).map(x => x && x.token).filter(Boolean);
          resolve(tokens);
        }catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}

function buildNotificationFromType(type, payload){
  switch(type){
    case 'auction_open':
      return { title: 'Asta aperta', body: `${payload.player} (${payload.role || '—'}) – base ${payload.bid} crediti`, link: '/' };
    case 'bid':
      return { title: 'Nuovo rilancio', body: `${payload.player}: ${payload.bid} crediti da ${payload.bidder}`, link: '/' };
    case 'assigned':
      return { title: 'Asta chiusa', body: `${payload.player} a ${payload.winner} per ${payload.price} crediti`, link: '/' };
    default:
      return { title: 'FantAsta', body: 'Aggiornamento', link: '/' };
  }
}

// 🔎 log esito per token (utile per capire gli errori Android)
async function logResult(token, ok, err){
  try {
    const key = token.replace(/[^a-zA-Z0-9_-]/g, '');
    const payload = ok
      ? { lastOkAt: Date.now(), lastError: null }
      : { lastErrorAt: Date.now(), lastError: String(err||'unknown') };
    await fetch(`${RTDB_URL}/tokens/${key}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {}
}

// ✅ PATCH compat Android: icon/badge/urgenza nel blocco webpush
async function sendToToken(accessToken, token, notification){
  const body = {
    message: {
      token,
      // ❌ niente "notification" top-level qui
      webpush: {
        headers: { Urgency: 'high', TTL: '120' },
        notification: {
          title: notification.title,
          body: notification.body,
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          vibrate: [100, 50, 100],
          requireInteraction: false
        },
        fcmOptions: { link: notification.link || '/' }
      }
    }
  };
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method:'POST',
    headers:{ 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`FCM ${resp.status}: ${txt}`);
  }
  return resp.json();
}
exports.handler = async (event) => {
  if (event.httpMethod === 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try{
    const body = JSON.parse(event.body || '{}');

// Percorso 1: { type, payload }
if (body.type) {
  const notif = buildNotificationFromType(body.type, body.payload || {});

  // ⬇️ PRIMA prendiamo token + accessToken
  const [accessToken, tokensRaw] = await Promise.all([
    getAccessToken(),
    fetchAllTokensFromRTDB()
  ]);

  // ⬇️ DEDUPLICA token (niente null, niente duplicati)
  const uniqueTokens = Array.from(new Set((tokensRaw || []).filter(Boolean)));
  if (!uniqueTokens.length) {
    return { statusCode: 200, body: 'Nessun token registrato' };
  }

  // ⬇️ INVIO ai soli token unici (con logResult invariato)
  const results = await Promise.all(uniqueTokens.map(async (t) => {
    try {
      const r = await sendToToken(accessToken, t, notif);
      await logResult(t, true);
      return r;
    } catch (e) {
      await logResult(t, false, e.message);
      return { error: e.message, token: t };
    }
  }));

  const ok = results.filter(r => !r.error).length;
  const ko = results.length - ok;
  return { statusCode: 200, body: `Inviate: ${ok}, errori: ${ko}` };
}

// Percorso 2: vecchio formato { title, body, tokens }
if (body.title && body.body) {
  // prendi eventuali token dal payload, altrimenti da RTDB
  let tokensRaw = Array.isArray(body.tokens) ? body.tokens : null;
  if (!tokensRaw || !tokensRaw.length) {
    tokensRaw = await fetchAllTokensFromRTDB();
  }

  // ⬇️ DEDUPLICA token
  const uniqueTokens = Array.from(new Set((tokensRaw || []).filter(Boolean)));
  if (!uniqueTokens.length) {
    return { statusCode: 200, body: 'Nessun token registrato' };
  }

  const notif = { title: body.title, body: body.body, link: '/' };
  const accessToken = await getAccessToken();

  const results = await Promise.all(uniqueTokens.map(async (t) => {
    try {
      const r = await sendToToken(accessToken, t, notif);
      await logResult(t, true);
      return r;
    } catch (e) {
      await logResult(t, false, e.message);
      return { error: e.message, token: t };
    }
  }));

  const ok = results.filter(r => !r.error).length;
  const ko = results.length - ok;
  return { statusCode: 200, body: `Inviate: ${ok}, errori: ${ko}` };
}

    return { statusCode: 400, body: 'Payload non valido (manca type oppure title/body)' };
  }catch(e){
    return { statusCode: 500, body: 'ERR: ' + (e && e.message || String(e)) };
  }
};




