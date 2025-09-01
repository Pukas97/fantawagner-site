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

// Firebase compat
const firebaseConfig = {
  apiKey: "AIzaSyBRo2tcepT9VqHYo7TekSGnG93kpTm6KaY",
  authDomain: "fanta-wagner.firebaseapp.com",
  databaseURL: "https://fanta-wagner-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "fanta-wagner",
  storageBucket: "fanta-wagner.appspot.com",
  messagingSenderId: "97053268763",
  appId: "1:97053268763:web:95ec2acd4f41b65a9091be"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auctionsRef = db.ref('auctions');

// Utils
function el(id){ return document.getElementById(id); }
function now(){ return Date.now(); }
function toNumber(x){ var n = Number(x); return isNaN(n) ? 0 : n; }
function pad2(n){ return (n<10?'0':'')+n; }
function fmtTime(ms){
  if (ms < 0) return '00:00';
  var s = Math.floor(ms/1000);
  var m = Math.floor(s/60);
  var ss = s%60;
  return pad2(m)+':'+pad2(ss);
}

// Storage semplice per “già assegnati”
function isLockedPlayer(name){
  try{
    var locked = JSON.parse(localStorage.getItem('lockedPlayers')||'[]');
    return locked.indexOf(name) !== -1;
  }catch(e){ return false; }
}
function lockPlayer(name){
  try{
    var locked = JSON.parse(localStorage.getItem('lockedPlayers')||'[]');
    if (locked.indexOf(name) === -1) locked.push(name);
    localStorage.setItem('lockedPlayers', JSON.stringify(locked));
  }catch(e){}
}

// CSV parsing
function parseCSV(text){
  var lines = text.split(/\r?\n/);
  var headers = lines[0].split(';').map(s=>s.trim());
  var rows = [];
  for (var i=1;i<lines.length;i++){
    var line = lines[i]; if (!line.trim()) continue;
    var cols = line.split(';');
    var row = {};
    headers.forEach(function(h,idx){ row[h] = (cols[idx]||'').trim(); });
    rows.push(row);
  }
  window.listone = rows;
  renderListone(rows);
  var status = document.getElementById('bootStatus');
  if (status) status.textContent = 'Listone caricato ('+rows.length+' giocatori)';
}

// Render listone
function renderListone(rows){
  var box = el('listoneBox'); if (!box) return;
  box.innerHTML = '';
  var q = (el('search') && el('search').value || '').toLowerCase();

  rows.forEach(function(r){
    var name = r['Nome'] || r['Giocatore'] || r['Player'] || '';
    if (q && name.toLowerCase().indexOf(q) === -1) return;

    var card = document.createElement('div');
    card.className = 'player';
    card.innerHTML =
      `<div class="head"><strong>${name}</strong> <span class="muted">(${r['Ruolo']||r['Role']||'—'}, ${r['Squadra']||r['Team']||'—'})</span></div>
       <div class="meta">Quotazione: <strong>${r['Quotazione']||r['Quota']||r['Prezzo']||0}</strong></div>
       <div class="actions">
         <button class="open-btn">Apri asta</button>
       </div>`;
    card.querySelector('.open-btn').addEventListener('click', function(){
      startAuctionFromRow(r);
    });
    box.appendChild(card);
  });
}

// Carica CSV
(function bootCSV(){
  fetch('listone.csv')
    .then(r => r.text())
    .then(function(text){
      parseCSV(text);
      var status = document.getElementById('bootStatus');
      if (status) status.innerHTML = 'Pronto ✅';
    })
    .catch(function(err){
      var status = document.getElementById('bootStatus');
      if (status) status.innerHTML = 'Errore nel caricamento CSV';
      debug('CSV ERROR: ' + (err && err.message || String(err)));
    });
})();

// Ricerca
if (el('search')){
  el('search').addEventListener('input', function(){
    renderListone(window.listone || []);
  });
}

// Avvio asta da riga CSV
function startAuctionFromRow(r){
  var player = r['Nome'] || r['Giocatore'] || r['Player'];
  var role   = r['Ruolo'] || r['Role'];
  var team   = r['Squadra'] || r['Team'];
  var quota  = r['Quotazione'] || r['quotazione'] || r['Quota'] || r['Prezzo'];
  var startBid = toNumber(quota);
  if (isLockedPlayer(player)) return;

  var timerMinutes = (el('timerMinutes') && el('timerMinutes').value) || '1';
  var endAt = now() + Math.max(1, parseInt(timerMinutes,10)||1) * 60000;

  var meOpen = el('myName').value.trim() || 'Anonimo';
  auctionsRef.push({
    player: player,
    role: role,
    team: team,
    bid: startBid,
    lastBidder: '',
    status: 'open',
    createdAt: now(),
    endAt: endAt,
    openedByName: meOpen,                       // NEW
    openedByTokenKey: (window.myTokenKey || '') // NEW
  }, function(err){
    if (err) { debug('create auction ERROR: ' + err.message); }
  });
}

// Bids
window.raiseBid = function(key, amount){
  var me = el('myName').value.trim() || 'Anonimo';
  var a = auctionsCache[key]; if (!a || a.status !== 'open') return;
  var next = toNumber(a.bid) + toNumber(amount);
  var patch = { bid: next, lastBidder: me, lastBidderTokenKey: (window.myTokenKey || '') };

  db.ref('auctions/'+key).update(patch);
  if (window.myTokenKey) {
    db.ref('auctions/'+key+'/participants/'+window.myTokenKey).update({ name: me, joinedAt: now() });
  }
};

window.customBid = function(key){
  var me = el('myName').value.trim() || 'Anonimo';
  var val = toNumber(el('manualBid-'+key).value);
  if (!(val>0)) return;
  var patch = { bid: val, lastBidder: me, lastBidderTokenKey: (window.myTokenKey || '') };

  db.ref('auctions/'+key).update(patch);
  if (window.myTokenKey) {
    db.ref('auctions/'+key+'/participants/'+window.myTokenKey).update({ name: me, joinedAt: now() });
  }
  el('manualBid-'+key).value = '';
};

// Assegna / Chiudi
window.assignAuction = function(key){
  db.ref('auctions/'+key).once('value').then(function(s){
    var a = s.val() || {};
    if (!a.player) return;
    lockPlayer(a.player);
    var patch = { status: 'closed', closedAt: now() };
    db.ref('auctions/'+key).update(patch);
  });
};

window.resetAllAuctions = function(){
  if (!confirm('Sicuro di voler cancellare tutte le aste?')) return;
  auctionsRef.remove();
  localStorage.removeItem('lockedPlayers');
  renderListone(window.listone||[]);
};

// Rendering aste
var auctionsCache = {};
function renderAuctions(){
  var box = el('auctions'); if (!box) return;
  box.innerHTML = '';

  Object.keys(auctionsCache).sort(function(a,b){
    return auctionsCache[b].createdAt - auctionsCache[a].createdAt;
  }).forEach(function(key){
    var a = auctionsCache[key];

    var card = document.createElement('div');
    card.className = 'auction ' + (a.status || 'open');

    // timer
    var left = (a.endAt||0) - now();
    var timerSpan = `<span class="timer" data-key="${key}">${fmtTime(left)}</span>`;

    var controls = `
      <div class="controls">
        <button onclick="raiseBid('${key}',1)">+1</button>
        <button onclick="raiseBid('${key}',5)">+5</button>
        <button onclick="raiseBid('${key}',10)">+10</button>
        <input id="manualBid-${key}" class="manual" placeholder="Offerta manuale" inputmode="numeric">
        <button onclick="customBid('${key}')">Offri</button>
        <button class="danger" onclick="assignAuction('${key}')">Assegna / Chiudi</button>
      </div>`;

    card.innerHTML =
        `<div><strong>${a.player}</strong> <span class="muted">(${a.role||'—'}, ${a.team||''})</span> • ${timerSpan}</div>
         <div class="opener muted">Aperta da: <span class="who">${a.openedByName || '—'}</span></div>
         <div class="price">${a.bid||0}</div>
         <div class="last-bidder">Ultimo rilancio: <span class="who">${a.lastBidder||'—'}</span></div>
         ${controls}`;

    box.appendChild(card);
  });
}

// Tick timer
setInterval(function(){
  var timers = document.querySelectorAll('.timer');
  timers.forEach(function(t){
    var key = t.getAttribute('data-key');
    var a = auctionsCache[key]; if (!a) return;
    var left = (a.endAt||0) - now();
    t.textContent = fmtTime(left);
    if (left <= 0 && a.status === 'open'){
      // chiudi automaticamente
      db.ref('auctions/'+key).update({ status:'closed', closedAt: now() });
    }
  });
}, 500);

// Realtime listeners
auctionsRef.on('value', function(s){
  auctionsCache = s.val() || {};
  renderAuctions();
});

auctionsRef.on('child_added', function(snap){
  var a = snap.val();
  auctionsCache = auctionsCache || {};
  auctionsCache[snap.key] = a;
  renderAuctions();
  if (a && a.status === 'open') {
    notifyOpenOnce(snap.key, a);
  }
});

auctionsRef.on('child_changed', function(snap){
  var a = snap.val();
  auctionsCache = auctionsCache || {};
  auctionsCache[snap.key] = a;
  renderAuctions();
  if (a && a.status === 'open') {
    notifyBidOnce(snap.key, a);
  }
});

// === 🔔 Push ===
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
    window.myTokenKey = tokenKey; // NEW: salva chiave token per targeting
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

// Invio centralizzato via Netlify function (tutti)
async function sendPushToAll(title, body){
  try {
    const res = await fetch('/.netlify/functions/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body })
    });
    const txt = await res.text();
    debug('notify all ' + res.status + ' -> ' + txt);
  } catch (e) {
    debug('notify ERROR: ' + (e && e.message || String(e)));
  }
}

// Invio targettizzato verso specifici tokenKeys (risolti lato server in token FCM)
async function sendPushToTargets(tokenKeys, title, body){
  try {
    const res = await fetch('/.netlify/functions/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, tokenKeys })
    });
    const txt = await res.text();
    debug('notify targeted ' + res.status + ' -> ' + txt);
  } catch (e) {
    debug('notify targeted ERROR: ' + (e && e.message || String(e)));
  }
}

// Notifica apertura UNA SOLA VOLTA per asta (usa transazione "notifOpenAt")
function notifyOpenOnce(key, a){
  const ts = Date.now();
  const ref = firebase.database().ref('auctions/'+key+'/notifOpenAt');

  ref.transaction(cur => cur || ts, function(error, committed, snapshot){
    if (error) { debug('tx notifOpenAt ERROR: ' + error.message); return; }
    if (committed && snapshot && Number(snapshot.val()) === ts) {
      const title = 'Asta aperta';
      const body  = a.player + ' (' + (a.role||'') + (a.team ? ', ' + a.team : '') + ') — da ' + (a.openedByName || '—');
      sendPushToAll(title, body);
    }
  });
}

// Notifica rilancio UNA SOLA VOLTA per ogni nuova cifra (targettizzata)
function notifyBidOnce(key, a){
  const bidderName = (a && a.lastBidder || '').trim();
  const bidderKey  = (a && a.lastBidderTokenKey || '').trim();
  const nextBid    = toNumber(a && a.bid);

  // evita falsi rilanci: serve offerente e bid > 0 con asta aperta
  if (!(a && a.status === 'open' && bidderName && nextBid > 0)) return;

  const ref = firebase.database().ref('auctions/'+key+'/lastNotifiedBid');

  ref.transaction(cur => {
    const current = toNumber(cur);
    return nextBid > current ? nextBid : undefined; // notifica solo una volta per cifra
  }, function(error, committed, snapshot){
    if (error) { debug('tx lastNotifiedBid ERROR: ' + error.message); return; }
    if (!(committed && toNumber(snapshot && snapshot.val()) === nextBid)) return;

    // destinatari: partecipanti (chi ha già rilanciato), escluso il rilanciante
    // se non ci sono partecipanti -> solo l'apritore
    firebase.database().ref('auctions/'+key+'/participants').once('value')
      .then(function(s){
        const parts = s.val() || {};
        let tokenKeys = Object.keys(parts).filter(k => k && k !== bidderKey);

        if (!tokenKeys.length) {
          const openerKey = (a.openedByTokenKey || '');
          if (openerKey && openerKey !== bidderKey) tokenKeys = [openerKey];
        }
        if (!tokenKeys.length) return; // nessuno da notificare

        const title = 'Nuovo rilancio';
        const body  = a.player + ' a ' + nextBid + ' (da ' + bidderName + ')';
        sendPushToTargets(tokenKeys, title, body);
      })
      .catch(function(e){ debug('read participants ERROR: ' + (e && e.message || String(e))); });
  });
}
