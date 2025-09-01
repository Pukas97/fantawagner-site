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


async function fetchTokensRespectingMute(auctionKey, preferredKeys){
  return new Promise((resolve, reject) => {
    https.get(`${RTDB_URL}/tokens.json`, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try{
          const val = JSON.parse(String(data||'null')) || {};
          const keySet = preferredKeys && preferredKeys.length ? new Set(preferredKeys) : null;
          const tokensArr = Object.entries(val).reduce((arr, [k, v]) => {
            if (!v || !v.token) return arr;
            if (keySet && !keySet.has(k)) return arr;
            const muted = v.mute && auctionKey && (v.mute[auctionKey] === true);
            if (!muted) arr.push(v.token);
            return arr;
          }, []);
          const tokens = Array.from(new Set(tokensArr));
          resolve(tokens);
        }catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}
function fetchTokensByKeys(keys){
  const keySet = new Set(keys || []);
  if (!keySet.size) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    https.get(`${RTDB_URL}/tokens.json`, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try{
          const val = JSON.parse(String(data||'null')) || {};
          const selected = Array.from(new Set(Object.entries(val)
            .filter(([k, v]) => keySet.has(k) && v && v.token)
            .map(([k, v]) => v.token)));
          resolve(selected);
        }catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}

function buildNotificationFromType(type, payload){
  switch(type){
    case 'auction_open':
      return { title: 'Asta aperta', body: `${payload.player} (${payload.role || '—'}${payload.team ? ', ' + payload.team : ''}) — da ${payload.openedByName || '—'}`, link: '/' };
    case 'bid':
      return { title: 'Nuovo rilancio', body: `${payload.player}: ${payload.bid} crediti da ${payload.bidder}`, link: '/' };
    case 'assigned':
      return { title: 'Assegnato', body: `${payload.player} a ${payload.winner} per ${payload.bid} crediti`, link: '/' };
    default:
      return { title: String(type||'Notifica'), body: payload && payload.body || '', link: '/' };
  }
}

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

// HTTP helper using Node 18 fetch; Netlify supports global fetch in functions runtime
async function sendToToken(accessToken, token, notification){
  const body = {
    message: {
      token,
      webpush: {
        headers: { Urgency: 'high', TTL: '120' }, // TTL 120s
        notification: {
          title: notification.title,
          body: notification.body,
          icon: '/icons/icon-192.png',   // assicurati che esista
          badge: '/icons/icon-192.png',  // opzionale
          vibrate: [100, 50, 100],
        },
        fcm_options: {
          link: notification.link || '/'
        }
      }
    }
  };

  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '');
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
      const auctionKey = (body.payload && body.payload.auctionKey) || null;

      // preferisci target tokenKeys se presenti; altrimenti rispetta i mute per asta
      let tokens = [];
      if (Array.isArray(body.tokenKeys) && body.tokenKeys.length) {
        tokens = await fetchTokensByKeys(body.tokenKeys);
      } else {
        tokens = await fetchTokensRespectingMute(auctionKey);
      }
      if (!tokens.length) return { statusCode: 200, body: 'Nessun token registrato' };

      const accessToken = await getAccessToken();
      const results = await Promise.all(tokens.map(async t => {
        try {
          const r = await sendToToken(accessToken, t, notif);
          await logResult(t, true);
          return r;
        } catch(e) {
          await logResult(t, false, e.message);
          return { error: e.message };
        }
      }));
      const ok = results.filter(r => !r.error).length;
      const ko = results.length - ok;
      return { statusCode: 200, body: `Inviate: ${ok}, errori: ${ko}` };
    }

    // Percorso 2: { title, body, link?, tokenKeys? } oppure { title, body, tokens? }
    if (body.title && body.body) {
      const notif = { title: body.title, body: body.body, link: body.link || '/' };

      let tokens = Array.isArray(body.tokens) ? body.tokens : null;
      if ((!tokens || !tokens.length) && Array.isArray(body.tokenKeys) && body.tokenKeys.length) {
        tokens = await fetchTokensByKeys(body.tokenKeys);
      }
      if (!tokens || !tokens.length) {
        tokens = await fetchAllTokensFromRTDB();
      }
      if (!tokens.length) return { statusCode: 200, body: 'Nessun token registrato' };

      const accessToken = await getAccessToken();
      const results = await Promise.all(tokens.map(async t => {
        try {
          const r = await sendToToken(accessToken, t, notif);
          await logResult(t, true);
          return r;
        } catch(e) {
          await logResult(t, false, e.message);
          return { error: e.message };
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
