// v3 — invio "data-only" (FCM v1) con eventId/tag per dedupe/collapse
const { GoogleAuth } = require('google-auth-library');
const https = require('https');

const PROJECT_ID = 'fanta-wagner';
const RTDB_URL   = 'https://fanta-wagner-default-rtdb.europe-west1.firebasedatabase.app';

function getServiceAccountFromEnv(){
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT non impostata');
  try { return JSON.parse(raw); }
  catch { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
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

// Costruisce il payload "data-only" usato dal SW
function buildDataPayload(type, payload){
  switch(type){
    case 'auction_open':
      return {
        title: 'Asta aperta',
        body: `${payload.player} (${payload.role || '—'}) – base ${payload.bid}`,
        tag: `auction:${payload.player}`,                   // collapse nativo
        eventId: `open:${payload.player}:${payload.bid}`,   // dedupe SW
        link: '/'
      };
    case 'bid':
      return {
        title: 'Nuovo rilancio',
        body: `${payload.player}: ${payload.bid} da ${payload.bidder}`,
        tag: `auction:${payload.player}`,
        eventId: `bid:${payload.player}:${payload.bid}`,
        link: '/'
      };
    default:
      return {
        title: 'FantAsta',
        body: 'Aggiornamento',
        tag: 'misc',
        eventId: `misc:${Date.now()}`,
        link: '/'
      };
  }
}

async function sendToToken(accessToken, token, data){
  const body = { message: { token, data } }; // <-- SOLO data (niente "notification")
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

// Log minimale su RTDB per debug consegna
async function logDebug(obj){
  try{
    await fetch(`${RTDB_URL}/_debug/notify.json`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ at: Date.now(), ...obj })
    });
  }catch{}
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try{
    const body = JSON.parse(event.body || '{}');
    const type = body.type;
    if (!type) return { statusCode: 400, body: 'Payload non valido (manca type)' };

    const data = buildDataPayload(type, body.payload || {});
    const [accessToken, tokens] = await Promise.all([ getAccessToken(), fetchAllTokensFromRTDB() ]);
    if (!tokens.length) {
      await logDebug({ type, data, info:'no-tokens' });
      return { statusCode: 200, body: 'Nessun token registrato' };
    }

    const results = await Promise.all(tokens.map(async t => {
      try {
        const r = await sendToToken(accessToken, t, data);
        await logDebug({ type, data, token: t.slice(0,20)+'…', ok: true, resp: r?.name || 'ok' });
        return r;
      } catch(e) {
        await logDebug({ type, data, token: t.slice(0,20)+'…', ok: false, err: String(e?.message || e) });
        return { error: e.message };
      }
    }));
    const ok = results.filter(r => !r.error).length;
    const ko = results.length - ok;
    return { statusCode: 200, body: `Inviate: ${ok}, errori: ${ko}` };
  }catch(e){
    await logDebug({ ok:false, fatal:String(e?.message || e) });
    return { statusCode: 500, body: 'ERR: ' + (e?.message || String(e)) };
  }
};
