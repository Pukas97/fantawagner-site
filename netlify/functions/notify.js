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
  const auth = new GoogleAuth({ credentials: sa, scopes:['https://www.googleapis.com/auth/firebase.messaging'] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

function fetchAllTokensFromRTDB(){
  return new Promise((resolve, reject) => {
    https.get(`${RTDB_URL}/tokens.json`, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try{
          const val = JSON.parse(data||'null') || {};
          resolve(Object.values(val).map(x=>x&&x.token).filter(Boolean));
        }catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}

// build notification payload → solo data
function buildDataPayload(type, payload){
  switch(type){
    case 'auction_open':
      return {
        title:'Asta aperta',
        body:`${payload.player} (${payload.role||'—'}) – base ${payload.bid}`,
        eventId:`open:${payload.player}:${payload.bid}`,
        tag:`auction:${payload.player}`
      };
    case 'bid':
      return {
        title:'Nuovo rilancio',
        body:`${payload.player}: ${payload.bid} da ${payload.bidder}`,
        eventId:`bid:${payload.player}:${payload.bid}`,
        tag:`auction:${payload.player}`
      };
    default:
      return { title:'FantAsta', body:'Aggiornamento', eventId:`misc:${Date.now()}`, tag:'misc' };
  }
}

async function sendToToken(accessToken, token, data){
  const body = { message:{ token, data } };
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${accessToken}`, 'Content-Type':'application/json' },
    body:JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`FCM ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode:405, body:'Method Not Allowed' };
  try{
    const body = JSON.parse(event.body||'{}');
    const type = body.type;
    if (!type) return { statusCode:400, body:'Payload non valido' };
    const data = buildDataPayload(type, body.payload||{});
    const [accessToken, tokens] = await Promise.all([ getAccessToken(), fetchAllTokensFromRTDB() ]);
    if (!tokens.length) return { statusCode:200, body:'Nessun token registrato' };
    await Promise.all(tokens.map(t => sendToToken(accessToken, t, data).catch(e=>e)));
    return { statusCode:200, body:`Inviato ${tokens.length} token` };
  }catch(e){ return { statusCode:500, body:'ERR: '+e.message }; }
};
