// Banner
(function(){
  var bs = document.getElementById('bootStatus');
  if (bs) bs.textContent = 'HTML caricato — avvio JS…';
})();

// Debug helper
function debug(msg){
  try {
    var box = document.getElementById('debugBox');
    if (!box) return;
    var line = document.createElement('div');
    line.textContent = msg;
    box.appendChild(line);
    console.log('[ASTA]', msg);
  } catch(e){}
}
debug('app.js caricato ✅');

// Firebase compat (globali già caricate da index.html)
const firebaseConfig = {
  apiKey: "AIzaSyBRo2tcepT9VqHYo7TekSGnG93kpTm6KaY",
  authDomain: "fanta-wagner.firebaseapp.com",
  databaseURL: "https://fanta-wagner-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "fanta-wagner",
  storageBucket: "fanta-wagner.firebasestorage.app",
  messagingSenderId: "97053268763",
  appId: "1:97053268763:web:95ec2acd4f41b65a9091be",
  measurementId: "G-Y0BB797KJG"
};

firebase.initializeApp(firebaseConfig);
debug('firebase init ok');
const db = firebase.database();

// test DB
db.ref('__ping').set(Date.now())
  .then(()=>debug('rtdb write: ok'))
  .catch(err=>debug('rtdb write ERROR: ' + (err && err.message || String(err))));

// === NOTIFY LOCK: evita invii duplicati tra più schede/dispositivi ===
function b64(s){ try { return btoa(unescape(encodeURIComponent(String(s)))).replace(/=+$/,''); } catch(e){ return String(Math.random()).slice(2); } }

async function acquireNotifyLock(key){
  const lockRef = db.ref('notifyLocks/' + b64(key));
  const res = await lockRef.transaction(curr => {
    if (curr && curr.at) return curr; // già preso
    return { at: Date.now() };
  });
  return !!(res && res.committed);
}

async function fireNotifyOnce(title, body, lockKey){
  try{
    const got = await acquireNotifyLock(lockKey);
    if (!got) { debug('notify SKIP (lock)', lockKey); return; }
    const res = await fetch('/.netlify/functions/notify', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ title, body })
    });
    const txt = await res.text().catch(()=> '');
    debug('notify sent', lockKey, res.status, txt);
  }catch(e){
    debug('notify error', lockKey, e && e.message || String(e));
  }
}

// === Refs
const auctionsRef     = db.ref('auctions');     // aste multiple
const assignmentsRef  = db.ref('assignments');
const participantsRef = db.ref('participants');

const START_BUDGET = 500;

// === Stato
var rows = [];
var headers = [];
var filterValue = '';
var participants = {};
var assignmentsCache = [];
var auctionsCache = {}; // key -> auction

function el(id){ return document.getElementById(id); }
function toNumber(v){ var n = Number(String(v||'').replace(/[^0-9.-]/g,'')); return isNaN(n)?0:n; }
function norm(s){ return String(s||'').trim().toLowerCase(); }

// === CSV
async function loadCSV(){
  var status = el('csvStatus');
  try{
    if (status) status.textContent = 'Cerco listone.csv…';
    var url = 'listone.csv?v=' + Date.now();
    debug('fetch ' + url);
    var res = await fetch(url, { cache: 'no-store' });
    debug('CSV status: ' + res.status);
    if (!res.ok) { if (status) status.textContent = 'Errore CSV: HTTP ' + res.status; throw new Error('HTTP '+res.status); }
    var text = await res.text();
    debug('CSV text len: ' + text.length);
    parseCSV(text);
    debug('headers: ' + headers.join(' | '));
    debug('rows: ' + rows.length);
    if (status) status.innerHTML = '<span class="pill">'+rows.length+'</span> giocatori caricati';
    renderTable();
  }catch(e){
    if (status) status.textContent = 'listone.csv non trovato o errore di parsing';
    debug('CSV ERROR: ' + (e && e.message ? e.message : String(e)));
  }
}
window.loadCSV = loadCSV;

function parseCSV(text){
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
  var sep = ',';
  if (text.indexOf('\t')>-1 && text.indexOf(';')===-1 && text.indexOf(',')===-1) sep='\t';
  else if (text.indexOf(';')>-1 && text.indexOf(',')===-1) sep=';';
  var lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return;
  headers = lines[0].split(sep).map(function(h){ return h.trim(); });
  rows = lines.slice(1).map(function(line){
    var cols = line.split(sep);
    var obj = {}; headers.forEach(function(h,i){ obj[h] = (cols[i]||'').trim(); });
    return obj;
  });
}

// === Elenco giocatori (CSV)
function getField(obj, names){
  var map = {}; Object.keys(obj||{}).forEach(function(k){ map[norm(k)] = obj[k]; });
  for (var i=0;i<names.length;i++){ var k = norm(names[i]); if (k in map) return map[k]; }
  var vals = Object.values(obj||{}); return vals.length? vals[0]:'';
}

function renderTable(){
  var tbody = el('tbodyList'); if (!tbody) return; tbody.innerHTML='';
  var q = norm(filterValue);
  var filtered = rows.filter(function(r){ return norm(JSON.stringify(r)).includes(q); });
  if (!filtered.length){
    var tr0 = document.createElement('tr');
    tr0.innerHTML = '<td colspan="5" class="muted">Nessun giocatore da mostrare (controlla separatore e intestazioni CSV)</td>';
    tbody.appendChild(tr0);
    return;
  }
  filtered.forEach(function(r, idx){
    var tr = document.createElement('tr');
    var nome = getField(r, ['Nome','Giocatore','Player']);
    var ruolo = getField(r, ['Ruolo','R','Role']);
    var squadra = getField(r, ['Squadra','Team','Club']);
    var quota = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
    tr.innerHTML = '<td>'+nome+'</td>'+
      '<td class="nowrap">'+ruolo+'</td>'+
      '<td>'+squadra+'</td>'+
      '<td class="nowrap">'+quota+'</td>'+
      '<td class="nowrap"><button class="btn primary" data-idx="'+idx+'">Metti all\'asta</button></td>';
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-idx]').forEach(function(btn){
    btn.addEventListener('click', function(e){
      var i = Number(e.currentTarget.getAttribute('data-idx'));
      var r = filtered[i];
      startAuctionFromRow(r);
    });
  });
}

// === Aste multiple
function startAuctionFromRow(r){
  var player = getField(r, ['Nome','Giocatore','Player']);
  var role   = getField(r, ['Ruolo','R','Role']);
  var team   = getField(r, ['Squadra','Team','Club']);
  var quota  = getField(r, ['Quotazione','quotazione','Quota','Prezzo']);
  var startBid = toNumber(quota);
  var newRef = auctionsRef.push({
    player: player,
    role: role,
    team: team,
    bid: startBid,
    lastBidder: '',
    status: 'open',
    createdAt: Date.now()
  }, function(err){
    if (err) { debug('create auction ERROR: ' + err.message); }
  });
  debug('auction created: ' + newRef.key + ' -> ' + player);
}

// Bids per singola asta
window.raiseBid = function(key, amount){
  var me = el('myName').value.trim() || 'Anonimo';
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  var next = toNumber(a.bid) + amount;
  db.ref('auctions/'+key).update({ bid: next, lastBidder: me });
};
window.customBid = function(key){
  var me = el('myName').value.trim() || 'Anonimo';
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  var val = toNumber(document.getElementById('manualBid-'+key).value); if (!val) return;
  db.ref('auctions/'+key).update({ bid: val, lastBidder: me });
  document.getElementById('manualBid-'+key).value = '';
};

// Chiudi/assegna una singola asta
window.assignAuction = function(key){
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  if (!a.lastBidder || !toNumber(a.bid)) { alert('Nessuna offerta valida da assegnare.'); return; }
  assignmentsRef.push({
    player: a.player, role: a.role, team: a.team,
    price: toNumber(a.bid), winner: a.lastBidder, at: Date.now()
  }, function(err){
    if (err) { debug('assign ERROR: ' + err.message); return; }
    db.ref('auctions/'+key).update({ status: 'closed' });
  });
};

// Reset aperte / reset totale
window.resetOpenAuctions = function(){
  if (!confirm('Sicuro di voler cancellare TUTTE le aste APERTE?')) return;
  auctionsRef.once('value').then(function(s){
    var val = s.val()||{};
    var updates = {};
    Object.keys(val).forEach(function(k){
      if (val[k] && val[k].status === 'open') updates[k] = null;
    });
    if (Object.keys(updates).length) db.ref('auctions').update(updates);
  });
};
window.resetEverything = function(){
  if (!confirm('⚠️ RESET TOTALE: cancella aste, assegnazioni e partecipanti. Confermi?')) return;
  var updates = {
    auctions: null,
    assignments: null,
    participants: null,
    tokens: null,
    notifyLocks: null
  };
  db.ref().update(updates);
};

// Render aste
function renderAuctions(){
  var box = el('auctionsList');
  if (!box) return;
  box.innerHTML = '';
  var keys = Object.keys(auctionsCache);
  if (!keys.length){
    var empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Nessuna asta attiva. Aprine una dal listone a destra.';
    box.appendChild(empty);
    return;
  }
  keys.sort(function(a,b){
    var A=auctionsCache[a], B=auctionsCache[b];
    if (A.status!==B.status) return A.status==='open' ? -1 : 1;
    return (A.createdAt||0) - (B.createdAt||0);
  });
  keys.forEach(function(key){
    var a = auctionsCache[key];
    var card = document.createElement('div');
    card.className = 'participant';
    var statusTag = a.status==='open' ? '<span class="pill">APERTA</span>' : '<span class="pill">CHIUSA</span>';
    var controls = a.status==='open'
      ? (
        `<div class="grid-3" style="margin-top:8px;">
          <button class="btn" onclick="raiseBid('${key}',1)">+1</button>
          <button class="btn" onclick="raiseBid('${key}',5)">+5</button>
          <button class="btn" onclick="raiseBid('${key}',10)">+10</button>
        </div>
        <div class="row" style="margin-top:8px;">
          <input id="manualBid-${key}" type="number" min="0" step="1" placeholder="Offerta manuale" />
          <button class="btn primary" onclick="customBid('${key}')">Rilancia</button>
        </div>
        <div class="row" style="margin-top:8px;">
          <button class="btn warn" onclick="assignAuction('${key}')">Chiudi e assegna</button>
          <span></span>
        </div>`
      )
      : '';
    card.innerHTML =
      `<div><strong>${a.player}</strong> <span class="muted">(${a.role||'—'}, ${a.team||''})</span> ${statusTag}</div>
       <div class="muted">Offerta: <strong>${a.bid||0}</strong> • Ultimo: <span class="tag">${a.lastBidder||''}</span></div>
       ${controls}`;
    box.appendChild(card);
  });
}

// Ricerca live + bootstrap
window.addEventListener('DOMContentLoaded', function(){
  var s = document.getElementById('search');
  if (s) s.addEventListener('input', function(e){ filterValue = e.target.value; renderTable(); });
  var bs = document.getElementById('bootStatus'); if (bs) bs.textContent = 'JS avviato ✅';
  loadCSV();
});

// Live listeners
auctionsRef.on('value', function(s){
  auctionsCache = s.val() || {};
  renderAuctions();
});

participantsRef.on('value', function(s){
  participants = s.val()||{};
  renderParticipants(assignmentsCache);
});

assignmentsRef.on('value', function(s){
  var val = s.val()||{}; var items = Object.values(val).sort(function(a,b){ return a.at-b.at; });
  assignmentsCache = items;
  var list = document.getElementById('assignments'); list.innerHTML='';
  items.forEach(function(x){
    var li = document.createElement('li');
    var d = new Date(x.at);
    li.innerHTML = '<span class="pill">'+x.winner+'</span> si aggiudica <strong>'+x.player+'</strong> <span class="muted">('+(x.role||'—')+')</span> a <strong>'+x.price+'</strong> crediti <span class="muted">('+d.toLocaleString()+')</span>';
    list.appendChild(li);
  });
  document.getElementById('assignCount').textContent = items.length;
  renderParticipants(items);
});

// Partecipanti & budget
window.addParticipant = function(){
  var name = document.getElementById('newParticipant').value.trim();
  if (!name) { alert('Inserisci un nome partecipante'); return; }
  participantsRef.push({ name: name }, function(err){
    if (err) { debug('participant ERROR: ' + err.message); alert('Salvataggio partecipante fallito.'); }
  });
  document.getElementById('newParticipant').value = '';
};

function computeBudgets(assignList){
  var map = {};
  assignList.forEach(function(a){
    var key = norm(a.winner);
    if (!map[key]) map[key] = { name: a.winner, spent: 0, items: [] };
    map[key].spent += toNumber(a.price);
    map[key].items.push({ player: a.player, role: a.role, price: toNumber(a.price) });
  });
  return map;
}

function renderParticipants(assignList){
  var budgets = computeBudgets(assignList);
  var container = document.getElementById('participants');
  container.innerHTML = '';
  var arr = [];
  var p = participants || {}; Object.keys(p).forEach(function(id){ arr.push({ id:id, name:p[id].name }); });
  Object.values(budgets).forEach(function(b){ if (!arr.find(function(x){ return norm(x.name)===norm(b.name); })) arr.push({ id:'auto-'+norm(b.name), name:b.name }); });
  arr.sort(function(a,b){ return a.name.localeCompare(b.name); });
  arr.forEach(function(p){
    var b = budgets[norm(p.name)] || { name:p.name, spent:0, items:[] };
    var remaining = Math.max(0, START_BUDGET - b.spent);
    var div = document.createElement('div');
    div.className = 'participant';
    div.innerHTML = '<div><strong>'+p.name+'</strong> • <span class="budget">'+remaining+'</span>/<span class="muted">'+START_BUDGET+'</span> crediti (spesi: '+b.spent+')</div>'+
      '<ul style="margin:6px 0 0 16px; padding:0; list-style: disc;">'+ b.items.map(function(it){ return '<li>'+it.player+' <span class="muted">('+(it.role||'—')+')</span> – '+it.price+'</li>'; }).join('') + '</ul>';
    container.appendChild(div);
  });
}

// === 🔔 Web Push FCM ===
let fcmToken = null;
const messaging = firebase.messaging();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/firebase-messaging-sw.js')
    .then(function(reg) {
      debug('SW registrato');
      messaging.useServiceWorker(reg);
    })
    .catch(function(err){ debug('SW ERROR: ' + (err && err.message || String(err))); });
}

window.enablePush = async function(){
  try {
    await Notification.requestPermission();
    if (Notification.permission !== 'granted') { alert('Permesso negato.'); return; }

    const vapidKey = 'BDWmtT7_gKB9wdDiPAttBed939_smK9VJNK1aUceF-K3YmNAOA0UECeg2jQzr7x33O2PK6cuoureOYZuLLo8XNA';
    const token = await messaging.getToken({ vapidKey });
    if (!token) { alert('Token non ottenuto'); return; }
    fcmToken = token;
    debug('FCM token ok');

    const tokenKey = token.replace(/[^a-zA-Z0-9_-]/g, '');
    await firebase.database().ref('tokens/' + tokenKey).set({
      token: token,
      user: (document.getElementById('myName').value || 'Anonimo'),
      ua: navigator.userAgent,
      at: Date.now()
    });

    alert('Push abilitate su questo dispositivo ✔');
  } catch (e) {
    debug('enablePush ERROR: ' + (e && e.message || String(e)));
    alert('Impossibile abilitare la push.');
  }
};

// helper notifiche
function showLocalNotification(title, body){
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== 'granted') return;
    new Notification(title, { body: body });
  } catch(e){}
}

async function fetchAllTokens(){
  const snap = await firebase.database().ref('tokens').once('value');
  const val = snap.val() || {};
  return Object.values(val).map(x => x.token).filter(Boolean);
}

// === Invio push tramite Netlify Function ===
async function sendPushToAll(title, body){
  try {
    const tokens = await fetchAllTokens();
    if (!tokens.length) { debug('Nessun token registrato'); return; }
    const res = await fetch('/.netlify/functions/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tokens })
    });
    const j = await res.json().catch(()=> ({}));
    debug('notify status ' + res.status + ' -> ' + JSON.stringify(j));
  } catch (e) {
    debug('notify ERROR: ' + (e && e.message || String(e)));
  }
}

// === Hook notifiche sugli eventi ===
auctionsRef.on('child_added', async function(snap){
  const a = snap.val();
  if (a && a.status === 'open') {
    const title = 'Asta aperta';
    const body  = a.player + ' (' + (a.role||'') + (a.team ? ', ' + a.team : '') + ')';
    showLocalNotification(title, body);
    await fireNotifyOnce(title, body, 'open_'+snap.key);
  }
});

auctionsRef.on('child_changed', async function(snap){
  const a = snap.val();
  const prev = (auctionsCache && auctionsCache[snap.key]) || {};
  if (a && a.status === 'open' && Number(a.bid||0) > Number(prev.bid||0)) {
    const title = 'Nuovo rilancio';
    const body  = a.player + ' a ' + a.bid + ' (da ' + (a.lastBidder||'') + ')';
    showLocalNotification(title, body);
    await fireNotifyOnce(title, body, 'bid_'+snap.key+'_'+a.bid);
  }
});
