/* Swoop customer app.
   Card data never touches this file — the Hyperswitch SDK renders payment
   fields in its own iframe, which is what keeps us out of PCI scope. */

const S = {
  screen: 'home', user: null, wallet: 0, canBook: false, activity: [],
  config: {}, jobs: [], job: null, bids: [], sel: null, chat: [],
  draft: {
  service: '',
  address: '',
  date: '',
  time: '',
  urgent: null,
  },
  rating: 0,
  tip: 0,
  van: { x: 12, y: 84 },
  pings: 0, eta: 22, busy: false, error: null, loading: true, lastRouting: null,
};

/* ------------------------------------------------------------------ utils */
const $ = id => document.getElementById(id);
const fmt = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c ?? 0) / 100).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const initials = n => String(n).split(' ').map(w => w[0]).join('').slice(0, 2);
const say = t => { $('live').textContent = t; };

let toastT;
function toast(msg) {
  $('toast').innerHTML = `<div class="toast">${esc(msg)}</div>`;
  say(msg); clearTimeout(toastT);
  toastT = setTimeout(() => { $('toast').innerHTML = ''; }, 3400);
}

let USER = localStorage.getItem('swoop_user') || null;
async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json', 'x-swoop-user': USER || 'anon' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return json;
}

const ICON = {
  Plumbing: 'M8 4v6a4 4 0 0 0 8 0V4M6 20h12M12 14v6',
  Electrical: 'M13 3 5 14h6l-2 7 8-11h-6l2-7z',
  Locksmith: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
  'Appliance repair': 'M4 4h16v16H4zM4 9h16M8 6h.01M12 6h.01',
  HVAC: 'M4 7h16M4 12h16M4 17h16',
  Home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  Jobs: 'M4 7h16v13H4zM9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2',
  Wallet: 'M3 7h18v12H3zM3 7l2-3h12l2 3M16 13h2',
  Empty: 'M4 7h16v13H4zM9 12h6',
};
const icon = (name, cls = '') =>
  `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON[name] || ICON.Empty}"/></svg>`;

/* ---------------------------------------------------------------- loading */
async function refresh() {
  const me = await api('GET', '/api/me');
  S.user = me.user; S.wallet = me.wallet ?? 0; S.canBook = !!me.canBook;
  S.withdrawable = me.withdrawable ?? 0;   // credit isn't refundable to a card
  S.activity = list(me.activity);
  S.jobs = list(await api('GET', '/api/jobs'));
  S.loading = false;
}
async function loadJob(id) {
  const d = await api('GET', `/api/jobs/${id}`);
  S.job = d.job; S.bids = d.bids; S.jobPayment = d.payment; S.jobEvents = d.events;
}

/* ------------------------------------------------------------ wallet strip */
function renderStrip() {
  if (!S.user) { $('strip').hidden = true; return; }
  $('strip').hidden = false;
  const hold = S.job && ['RESERVED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(S.job.state)
    ? (S.jobPayment?.amount ?? 0) : 0;
  const email = localStorage.getItem('swoop_email') || S.user.display_email || '';
  const customerName = email ? email.split('@')[0] : 'Demo customer';
  $('who').textContent = `${customerName} · wallet`;
  $('wTotal').textContent = fmt(S.wallet);
  const parts = [['wallet', S.wallet, 'Available', '#5AE0A8'], ['hold', hold, 'Reserved for jobs', '#5A6CF5']];
  const sum = parts.reduce((s, p) => s + p[1], 0);
  $('wBar').innerHTML = sum === 0 ? '<div class="seg seg-empty"></div>'
    : parts.filter(p => p[1] > 0).map(p => `<div class="seg seg-${p[0]}" style="flex-grow:${p[1]}"></div>`).join('');
  $('wLegend').innerHTML = parts.map(p =>
    `<span><span class="dot" style="background:${p[3]}"></span>${p[2]} <b class="mono">${fmt(p[1])}</b></span>`).join('');
  $('wWarn').textContent = S.wallet < (S.config.walletFloor ?? 2500)
    ? `Keep ${fmt(S.config.walletFloor)} in your wallet to book — it covers tips.` : '';
}

/* ================================================================ screens */
const V = {};

V.home = () => `
<div class="screen">
  <div class="eyebrow">Swoop</div>
  <h1>What needs fixing?</h1>
  <p class="sub">Post a job, compare demo provider bids, and track their progress.</p>

  <div class="grid" style="margin-top:var(--s4)">
    ${['Plumbing', 'Electrical', 'Locksmith', 'Appliance repair', 'HVAC'].map(s => `
      <button class="tile" aria-pressed="${S.draft.service === s}" onclick="pick('${s}')">
        ${icon(s)}<span>${s}</span></button>`).join('')}
  </div>

  ${!S.canBook ? `
    <div class="note warn"><b>Add ${fmt((S.config.walletFloor ?? 2500) - S.wallet)} to get started.</b><br>
      Swoop keeps a ${fmt(S.config.walletFloor)} minimum in your wallet so you can tip instantly.
      Jobs themselves are charged to your card, not the wallet.</div>
    <button class="btn" onclick="openTopup()">Add money</button>`
    : `<button class="btn" onclick="go('post')">Continue with ${esc(S.draft.service)}</button>`}

  ${activeJob() ? `
    <div class="sectionhead"><h3>In progress</h3></div>
    ${jobCard(activeJob())}` : ''}
</div>`;

V.post = () => `
<div class="screen">
  <button class="back" onclick="go('home')">← Services</button>
  <div class="eyebrow">${esc(S.draft.service)}</div>
  <h1>Tell us what's wrong</h1>
  <label for="desc">Describe the job</label>
  <textarea id="desc" placeholder="${esc({
  Plumbing: 'Kitchen tap is dripping steadily and the cabinet underneath is damp.',
  Electrical: 'The kitchen outlets stopped working and resetting the breaker did not help.',
  Locksmith: 'The front-door deadbolt is jammed and the key will not turn.',
  'Appliance repair': 'The washing machine fills with water but stops before the spin cycle.',
  HVAC: 'The air conditioner is running, but the rooms are not getting cooler.'
}[S.draft.service] || 'Describe what is happening and what you need fixed.')}"
    oninput="S.draft.desc=this.value;hint()">${esc(S.draft.desc || '')}</textarea>
  <p class="sub" id="deschint">${(S.draft.desc || '').length < 8
    ? 'A sentence or two helps providers bid accurately.' : 'Good — enough for a provider to price it.'}</p>

  <label for="addr">Address</label>
  <label for="addr">Address</label>

<input
  id="addr"
  type="text"
  list="address-suggestions"
  autocomplete="street-address"
  placeholder="Start typing your address"
  value="${esc(S.draft.address || '')}"
  oninput="S.draft.address=this.value"
/>

<datalist id="address-suggestions">
  <option value="118 Mathilda Place, Sunnyvale, CA 94086"></option>
  <option value="201 South Market Street, San Jose, CA 95113"></option>
  <option value="450 Serra Mall, Stanford, CA 94305"></option>
  <option value="1600 Amphitheatre Parkway, Mountain View, CA 94043"></option>
  <option value="1 Hacker Way, Menlo Park, CA 94025"></option>
</datalist>

<p class="sub">Demo address suggestions for this prototype.</p>
  <div class="row">
    <div>
  <label for="d">Date</label>
  <input
    id="d"
    type="date"
    min="${new Date().toISOString().slice(0, 10)}"
    value="${esc(S.draft.date || '')}"
    onchange="S.draft.date=this.value"
  >
</div>

<div>
  <label for="t">Time</label>
  <input
    id="t"
    type="time"
    value="${esc(S.draft.time || '')}"
    onchange="S.draft.time=this.value"
  >
</div>
</div>

<label>How urgent?</label>

<div class="chips">
  <button
    type="button"
    class="chip"
    aria-pressed="${S.draft.urgent === false}"
    onclick="S.draft.urgent=false;render()">
    Scheduled
  </button>

  <button
    type="button"
    class="chip urgent"
    aria-pressed="${S.draft.urgent === true}"
    onclick="S.draft.urgent=true;render()">
    Emergency
  </button>
</div>

<p class="sub">${
  S.draft.urgent === null
    ? 'Choose Scheduled or Emergency.'
    : S.draft.urgent === true
      ? 'Prioritized for immediate service. Emergency bids may be higher.'
      : 'Providers bid for the date and time you selected.'
}</p>

<button
  class="btn ${S.draft.urgent === true ? 'btn-signal' : ''}"
  onclick="submitJob()"
  ${
    (S.draft.desc || '').trim().length < 8 ||
    !S.draft.address?.trim() ||
    !S.draft.date ||
    !S.draft.time ||
    S.draft.urgent === null ||
    S.busy
      ? 'disabled'
      : ''
  }>
  ${S.busy ? 'Posting…' : 'Request bids'}
</button>

  <p class="sub" style="text-align:center">Nothing is charged until you pick a provider.</p>
</div>`;

V.bids = () => {
  const best = bestOf();
  return `
<div class="screen">
  <button class="back" onclick="go('home')">← Home</button>
  <div class="eyebrow">${esc(S.job.service)}${S.job.is_emergency ? ' · Emergency' : ''}</div>
  <h1>${S.bids.length ? `${S.bids.length} providers bid` : 'Finding providers'}</h1>
  <p class="sub">${S.bids.length
    ? 'Choosing a provider confirms the total. Your card is charged securely, and Swoop reserves the captured funds for completion or cancellation.'
    : 'Notifying providers near you.'}</p>

  ${S.bids.length === 0 ? `<div class="card" style="margin-top:var(--s4)">
      <div class="skel" style="width:60%"></div><div class="skel" style="width:40%;margin-top:8px"></div></div>` : ''}

  ${S.bids.map((b, i) => `
    <button class="card tap ${S.sel === i ? 'sel' : ''}" aria-pressed="${S.sel === i}" onclick="S.sel=${i};render()"
      style="margin-top:var(--s3)">
      <div class="flex">
        <div class="who">
          <span class="avatar v${(i % 3) + 1}">${initials(b.provider_name)}</span>
          <span><b>${esc(b.trade)}</b><br>
            <span class="sub">${esc(b.provider_name)} · ★ ${b.rating}${b.jobs_done != null ? ` · ${b.jobs_done} jobs` : ''}</span></span>
        </div>
        <span class="mono" style="font-weight:700">${fmt(b.totalAmount)}</span>
      </div>
      ${b.note ? `<p class="sub" style="margin-top:var(--s2)">${esc(b.note)}</p>` : ''}
      <div>
        ${best.cheap === i ? '<span class="tag tag-best">Lowest price</span>' : ''}
        ${best.fast === i ? '<span class="tag tag-best">Arrives soonest</span>' : ''}
        ${best.top === i ? '<span class="tag tag-best">Highest rated</span>' : ''}
        <span class="tag tag-live">${b.eta_minutes} min away</span>
        <span class="tag"><span class="verified">✓ Verified</span></span>
      </div>
    </button>`).join('')}

  ${S.sel != null ? (() => { const b = S.bids[S.sel]; return `
    <div class="breakdown">
      <div><span>${esc(b.trade)}</span><span class="mono">${fmt(b.bidAmount)}</span></div>
      <div><span>Swoop service fee (7.5%)</span><span class="mono">${fmt(b.feeAmount)}</span></div>
      <div class="tot"><span>Total charged and reserved</span><span class="mono">${fmt(b.totalAmount)}</span></div>
    </div>
    <button class="btn" onclick="acceptBid()" ${S.busy ? 'disabled' : ''}>
      ${S.busy ? 'Processing payment…' : `Book ${esc(b.provider_name.split(' ')[0])}`}</button>`; })()
    : S.bids.length ? '<p class="sub" style="text-align:center;margin-top:var(--s4)">Tap a bid to see the total.</p>' : ''}
  ${S.error ? `<div class="note bad"><b>${esc(S.error)}</b></div>` : ''}
</div>`;
};

V.track = () => {
  const st = S.job.state;
  const steps = [['Booked', 'RESERVED'], ['On the way', 'EN_ROUTE'], ['Arrived', 'ARRIVED'],
                 ['Working', 'IN_PROGRESS'], ['Done', 'COMPLETED']];
  const idx = steps.findIndex(s => s[1] === st);
  const bid = acceptedBid();
  const t = tier(st);
  const stamps = Object.fromEntries((S.jobEvents || []).map(e => [e.kind, new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]));
  return `
<div class="screen">
  <button class="back" onclick="go('home')">← Home</button>
  <div class="eyebrow">${S.job.is_emergency ? 'Emergency · ' : ''}${esc(S.job.service)}</div>
  <div class="who" style="margin-top:4px">
    <span class="avatar">${initials(bid?.provider_name || '?')}</span>
    <span><h2>${esc(bid?.provider_name || 'Provider')}</h2>
      <span class="sub">${esc(bid?.trade || '')} · ★ ${bid?.rating ?? ''} <span class="verified">✓ Verified</span></span></span>
  </div>

  <div class="map" style="margin-top:var(--s4)" aria-label="Provider location">
    <div class="road" style="left:0;right:0;top:52%;height:9px"></div>
    <div class="road" style="top:0;bottom:0;left:66%;width:9px"></div>
    <div class="pin pin-home" style="left:70%;top:26%"></div>
    <div class="pin pin-van" style="left:${S.van.x}%;top:${S.van.y}%"></div>
    <div class="eta">${st === 'EN_ROUTE' ? `~${S.eta} min away` : st === 'RESERVED' ? 'Not set off yet'
      : st === 'ARRIVED' ? 'At your door' : 'On site'}</div>
  </div>
  <p class="sub mono" style="font-size:11px">${S.pings} location pings recorded — kept as evidence for this job</p>

  <ul class="tl">${steps.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}">
    <b>${s[0]}</b><div class="t mono">${stamps[s[1]] || '—'}</div></li>`).join('')}</ul>

  <div class="card">
    <div class="flex">
      <span class="sub">Captured and reserved for this job</span>
      <span class="mono">${fmt(S.jobPayment?.amount ?? 0)}</span>
    </div>
    <div class="flex">
      <span class="sub">Settlement</span>
      <span class="sub">Allocated when the job completes or is cancelled</span>
    </div>
  </div>

  <div class="note ${t.tone}"><b>${t.head}</b><br>${t.detail}</div>
  <button class="btn btn-quiet" onclick="askCancel()">Cancel this job</button>

  <div class="sectionhead"><h3>Messages</h3></div>
  <div class="chat" id="chat">${S.chat.map(m => `<div class="msg ${m.me ? 'me' : 'them'}">${esc(m.text)}</div>`).join('')
    || '<p class="sub">Say hello, or ask about arrival.</p>'}</div>
  <div class="row" style="margin-top:var(--s2)">
    <input id="msg" placeholder="Message ${esc(bid?.provider_name.split(' ')[0] || '')}" onkeydown="if(event.key==='Enter')sendMsg()">
    <button class="btn btn-sm" style="flex:0 0 74px" onclick="sendMsg()">Send</button>
  </div>

  <div class="sectionhead"><h3 class="sub" style="font-size:10px;letter-spacing:.14em;text-transform:uppercase">Demo — provider side</h3></div>
  <button class="btn btn-ghost" onclick="advance()" ${S.busy ? 'disabled' : ''}>
    ${idx < 4 ? `Advance to “${steps[idx + 1][0]}”` : 'Finish'}</button>
</div>`;
};

V.review = () => {
  const bid = acceptedBid(), first = bid?.provider_name.split(' ')[0] || 'them';
  return `
<div class="screen">
  <div class="eyebrow">Job complete</div>
  <h1>How did ${esc(first)} do?</h1>
  <p class="sub">${fmt(bid?.charge)} was charged to your card.</p>
  <div class="stars">${[1, 2, 3, 4, 5].map(n =>
    `<button class="star ${S.rating >= n ? 'on' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}" onclick="S.rating=${n};render()">★</button>`).join('')}</div>
  <p class="sub">${['Tap to rate', 'Poor', 'Not great', 'Fine', 'Good', 'Excellent'][S.rating]}</p>
  <label for="rev">Add a note (optional)</label>
  <textarea id="rev" placeholder="Turned up early and explained the fix"></textarea>

  <div class="sectionhead"><h3>Add a tip</h3></div>
  <p class="sub">Paid from your ${fmt(S.wallet)} wallet. ${esc(first)} keeps every cent — Swoop takes nothing.</p>
  <div class="chips" style="margin-top:var(--s2)">
    ${[0, 500, 1000, 2000].map(t => `<button class="chip" aria-pressed="${S.tip === t}"
      ${t > S.wallet ? 'disabled' : ''} onclick="S.tip=${t};render()">${t === 0 ? 'No tip' : fmt(t)}</button>`).join('')}
  </div>
  ${S.wallet < 2000 ? '<p class="sub">Greyed-out amounts are more than your wallet holds.</p>' : ''}
  <button class="btn" onclick="finish()" ${S.rating === 0 || S.busy ? 'disabled' : ''}>
    ${S.rating === 0 ? 'Rate to continue' : S.tip > 0 ? `Submit and tip ${fmt(S.tip)}` : 'Submit review'}</button>
</div>`;
};

V.jobs = () => `
<div class="screen">
  <div class="eyebrow">History</div>
  <h1>Your jobs</h1>
  ${S.jobs.length === 0 ? `<div class="empty">${icon('Empty')}<p>No jobs yet.</p>
    <button class="btn btn-ghost btn-sm" style="margin-top:var(--s3)" onclick="go('home')">Book your first</button></div>`
    : S.jobs.map(j => jobCard(j)).join('')}
</div>`;

V.wallet = () => `
<div class="screen">
  <div class="eyebrow">Wallet</div>
  <h1>${fmt(S.wallet)}</h1>
  <p class="sub">Covers tips and refunds. Jobs are charged to your card.</p>
  <button class="btn" onclick="openTopup()">Add money</button>
  ${S.wallet > 0 ? `<button class="btn btn-ghost" onclick="withdraw()">
  Withdraw to card <span class="sub">(simulated)</span>
</button>` : ''}
  <button class="btn btn-quiet" onclick="signOut()">Sign out</button>

  ${S.lastRouting?.length ? `
    <div class="sectionhead"><h3>How your last payment was routed</h3></div>
    <div class="trail">${S.lastRouting.map(a => `
      <div class="trail-row ${a.errorCode ? 'no' : 'ok'}">
        <span class="trail-n">${a.n}</span>
        <span><b>${esc(a.processor || 'unknown')}</b>${a.errorCode ? ` — ${esc(a.errorCode)}` : ' — succeeded'}</span>
      </div>`).join('')}</div>
    <p class="sub">Swoop doesn\u2019t pick the processor. Hyperswitch routes it, and retries elsewhere if the first declines.</p>` : ''}

  <div class="sectionhead"><h3>Activity</h3></div>
  <div class="ledger">
    ${S.activity.length === 0 ? '<p class="sub">Nothing yet.</p>' : S.activity.map(e => `
      <div class="e"><span>${esc(label(e.reason))}<br>
        <span class="sub mono" style="font-size:11px">${new Date(e.at).toLocaleString()}</span></span>
        <span class="mono ${e.walletDelta < 0 ? 'neg' : e.walletDelta > 0 ? 'pos' : ''}">${e.walletDelta ? fmt(e.walletDelta) : '—'}</span></div>`).join('')}
  </div>
</div>`;

/* ------------------------------------------------------------- fragments */
const STATE_LABEL = {
  OPEN_FOR_BIDS: 'Taking bids', RESERVED: 'Booked', EN_ROUTE: 'On the way',
  ARRIVED: 'Arrived', IN_PROGRESS: 'In progress', COMPLETED: 'Completed',
  CANCELLED_PRE_TRAVEL: 'Cancelled before travel',
  CANCELLED_EN_ROUTE: 'Cancelled after travel started',
  CANCELLED_IN_PROGRESS: 'Cancelled after work started',
};
const jobCard = j => `
  <button class="card tap" onclick="openJob('${j.id}')" style="margin-top:var(--s2)">
    <div class="flex"><b>${esc(j.service)}</b>
      <span class="tag ${['COMPLETED'].includes(j.state) ? 'tag-live'
        : j.state.startsWith('CANCELLED') ? 'tag-warn' : 'tag-best'}">${STATE_LABEL[j.state] || j.state}</span></div>
    <p class="sub">${esc(j.description)}</p>
    <div class="sub mono" style="font-size:11px;margin-top:6px">${new Date(j.created_at).toLocaleDateString()}</div>
  </button>`;

const label = r => ({
  WALLET_TOPUP: 'Wallet topped up', JOB_CAPTURED_AND_RESERVED: 'Payment captured and reserved',
  JOB_COMPLETED: 'Job funds allocated',
  JOB_SETTLED: 'Job settled', TIP: 'Tip', WITHDRAWAL_SIMULATED: 'Withdrawal to card simulated',
  CANCELLED_PRE_TRAVEL: 'Cancelled — full amount returned',
  CANCELLED_EN_ROUTE: 'Cancelled — provider travel compensation',
  CANCELLED_IN_PROGRESS: 'Cancelled — job allocated',
  CANCEL_SETTLE: 'Cancellation settled', PROVIDER_CANCELLED: 'Provider cancelled',
  PROVIDER_PENALTY: 'Compensation received', REFUND_SETTLED: 'Refund settled',
}[r] || r);

/** Collections from the API are never trusted to be arrays — a single bad
    response used to blank the home screen entirely. */
const list = v => (Array.isArray(v) ? v : []);
const isOver = j => {
  const st = String(j?.state ?? '');
  return st === 'COMPLETED' || st.startsWith('CANCELLED');
};
V.login = () => `
  <div class="screen" style="padding-top:54px">
    <div class="eyebrow">Swoop</div>
    <h1>Get someone out to you, fast.</h1>
    <p class="sub" style="margin-top:10px">Post the job, compare provider bids, and track their progress.
      Choose a provider, approve the total, and pay securely. Swoop reserves the captured funds for completion or cancellation.</p>

    <div class="section">
      <div class="card">
        <div class="who"><span class="avatar">1</span>
          <span><b>Describe it once</b><div class="sub">Nearby tradespeople bid on your job.</div></span></div>
      </div>
      <div class="card">
        <div class="who"><span class="avatar">2</span>
          <span><b>Pick who you like</b><div class="sub">Prices, ratings and arrival times side by side.</div></span></div>
      </div>
      <div class="card">
        <div class="who"><span class="avatar">3</span>
          <span><b>Approve and pay</b><div class="sub">Your approved total is charged and reserved by Swoop for the job.</div></span></div>
      </div>
    </div>

    <label for="email">Email</label>
    <input id="email" type="email" inputmode="email" autocomplete="email"
      placeholder="you@example.com" value="${esc(S.loginEmail || '')}"
      oninput="S.loginEmail=this.value" onkeydown="if(event.key==='Enter')signIn()">
    <button class="btn" onclick="signIn()" ${S.busy ? 'disabled' : ''}>
      ${S.busy ? '<span class="spin"></span> Signing in' : 'Continue'}</button>
    <p class="sub" style="text-align:center;margin-top:10px">Demo sign-in — no password, no email sent.</p>
  </div>`;

/** Derives a stable account id from the email so returning users keep their
    wallet, jobs and saved cards. */
/**
 * Email is only a demo display label.
 * Account identity is an unguessable UUID stored in this browser.
 */
async function signIn() {
  const email = String(S.loginEmail || '').trim().toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return toast('Enter a valid email address.');
  }

  S.busy = true;
  render();

  const storedUser = localStorage.getItem('swoop_user');
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(storedUser || '');

  USER = isUuid ? storedUser : crypto.randomUUID();

  localStorage.setItem('swoop_user', USER);
  localStorage.setItem('swoop_email', email);

  try {
    await refresh();
    S.screen = 'home';
    toast('Welcome to Swoop.');
  } catch (error) {
    console.error('Swoop sign-in failed:', error);
    toast('Could not reach Swoop. Check the browser console.');
  } finally {
    S.busy = false;
    render();
  }
}

function signOut() {
  localStorage.removeItem('swoop_user');
  localStorage.removeItem('swoop_email');
  USER = null;
  Object.assign(S, { user: null, wallet: 0, jobs: [], job: null, bids: [], activity: [], screen: 'login' });
  render();
}

const activeJob = () => list(S.jobs).find(j => !isOver(j));
const acceptedBid = () => list(S.bids).find(b => b.id === S.job?.accepted_bid_id) || list(S.bids)[0];
function bestOf() {
  if (list(S.bids).length < 2) return {};
  const idx = f => S.bids.reduce((b, x, i, a) => (f(x, a[b]) ? i : b), 0);
  return { cheap: idx((x, y) => x.amount < y.amount), fast: idx((x, y) => x.eta_minutes < y.eta_minutes), top: idx((x, y) => x.rating > y.rating) };
}
function tier(state) {
  if (state === 'RESERVED') {
    return {
      tone: 'good',
      head: 'Cancel now: full amount returned',
      detail:
        'The provider has not started travelling. The full captured amount will be credited to your Swoop wallet.',
    };
  }

  if (['EN_ROUTE', 'ARRIVED'].includes(state)) {
    return {
      tone: 'bad',
      head: 'Cancel now: $30 goes to the provider',
      detail:
        'The provider has committed time or travel. Swoop credits the remainder to your wallet.',
    };
  }
  if (state === 'IN_PROGRESS') {
    return {
      tone: 'bad',
      head: 'Cancel now: the full amount is retained',
      detail:
        'Work has started, so the job is charged in full.',
    };
  }

  return {
    tone: 'bad',
    head: 'This job can no longer be cancelled',
    detail: 'The job is already complete or cancelled.',
  };
}
function hint() {
  const el = document.getElementById('deschint');
  if (el) el.textContent = (S.draft.desc || '').length < 8
    ? 'A sentence or two helps providers bid accurately.' : 'Good — enough for a provider to price it.';
}
const pick = s => { S.draft.service = s; render(); };

/* ------------------------------------------------------------- payments */
let hyper = null, widgets = null, unified = null;

async function mountPayment(clientSecret, mountId, onDone) {
  if (!S.config.paymentReady || !S.config.publishableKey) {
    throw new Error(S.config.paymentConfigurationError ||
      'Card payments are not configured. Set HYPERSWITCH_PUBLISHABLE_KEY and reload.');
  }
  if (!clientSecret) throw new Error('Payment setup did not return a client secret.');
  hyper ??= Hyper(S.config.publishableKey);
  widgets = hyper.widgets({
  appearance: { theme: 'default' },
  clientSecret,
  locale: 'en'
});
  unified = widgets.create('payment', {
    wallets: {
    walletReturnUrl: window.location.origin,
    applePay: 'never',
    googlePay: 'never',
    payPal: 'never',
  },
    displaySavedPaymentMethodsCheckbox: false,
    displaySavedPaymentMethods: false,
  });
  unified.mount(`#${mountId}`);
  return async () => {
    const { error, status } = await hyper.confirmPayment({
      widgets, confirmParams: { return_url: window.location.href }, redirect: 'if_required',
    });
    if (error) throw new Error(error.message || 'Payment failed');
    return status;
  };
}

function openTopup() {
  const min = S.config.minTopup ?? 2500;
  let amount = 5000;
  $('modal').innerHTML = `
  <div class="veil"><div class="sheet" role="dialog" aria-modal="true" aria-label="Add money">
    <div class="grab"></div>
    <h2>Add money</h2>
    <p class="sub">Wallet money covers tips. Jobs are charged to your card separately.</p>
    <label>Amount</label>
    <div class="chips" id="amts">${[2500, 5000, 10000].map(a =>
      `<button class="chip" aria-pressed="${a === amount}" data-a="${a}">${fmt(a)}</button>`).join('')}</div>
    <p class="sub">Minimum ${fmt(min)}.</p>
    <div id="payslot" style="margin-top:var(--s4);min-height:80px">
      <div class="skel" style="height:46px"></div></div>
    <div id="payerr"></div>
    <button class="btn" id="paybtn" disabled>Preparing…</button>
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
  </div></div>`;

  const amts = $('amts');
  amts.onclick = e => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    amount = Number(b.dataset.a);
    [...amts.children].forEach(c => c.setAttribute('aria-pressed', String(Number(c.dataset.a) === amount)));
    requestId = crypto.randomUUID();
    prepare();
  };

  let confirmFn = null, token = 0, requestId = crypto.randomUUID();
  async function prepare() {
    const mine = ++token;
    $('paybtn').disabled = true; $('paybtn').textContent = 'Preparing…';
    $('payerr').innerHTML = '';
    try {
    const p = await api('POST', '/api/wallet/topup', {
  amount,
  requestId
});
      if (mine !== token) return;
      $('payslot').innerHTML = '';
      confirmFn = await mountPayment(p.clientSecret, 'payslot');
      $('paybtn').disabled = false;
      $('paybtn').textContent = `Add ${fmt(amount)}`;
      $('paybtn').onclick = async () => {
        $('paybtn').disabled = true; $('paybtn').textContent = 'Processing Payment';
        try {
          await confirmFn();
          const s = await api('POST', `/api/wallet/topup/${requestId}/reconcile`, {});
          S.lastRouting = s.routing;
          closeModal(); await refresh(); render();
          toast(`${fmt(amount)} added. ${s.routing?.length > 1 ? 'Routed via ' + s.routing.at(-1).connector + ' after a retry.' : ''}`);
        } catch (err) {
          $('payerr').innerHTML = `<div class="note bad"><b>${esc(err.message)}</b><br>Try a different card, or a smaller amount.</div>`;
          $('paybtn').disabled = false; $('paybtn').textContent = `Add ${fmt(amount)}`;
        }
      };
    } catch (err) {
      $('payerr').innerHTML = `<div class="note bad">${esc(err.message)}</div>`;
      $('paybtn').textContent = 'Try again'; $('paybtn').disabled = false; $('paybtn').onclick = prepare;
    }
  }
  prepare();
}

async function withdraw() {
  try {
    const amount = S.withdrawable;
    await api('POST', '/api/wallet/withdraw', {
      amount,
      withdrawalId: crypto.randomUUID(),
    });
    await refresh(); render();
    toast(`${fmt(amount)} withdrawal recorded. No card refund was sent in this demo.`);
  } catch (e) { toast(e.message); }
}
const closeModal = () => { $('modal').innerHTML = ''; };

/* --------------------------------------------------------------- actions */
async function submitJob() {
  if (!S.draft.address?.trim()) {
  return toast('Choose or enter the job address.');
}
  S.busy = true; render();
  try {
    const { id } = await api('POST', '/api/jobs', {
      service: S.draft.service, description: S.draft.desc,
      address: S.draft.address.trim(),
      scheduledFor: new Date(`${S.draft.date}T${S.draft.time}`).toISOString(),
      isEmergency: !!S.draft.urgent === true,
    });
    S.busy = false;

    await loadJob(id);
    await refresh();
    const arrivingBids = [...S.bids];

    S.bids = [];
    S.sel = null;
    go('bids');

    arrivingBids.forEach((bid, index) => {
      setTimeout(() => {
      // Do not update the wrong screen if the customer navigated away.
        if (S.job?.id !== id || S.screen !== 'bids') return;

          S.bids.push(bid);
          render();

          say(
            index === 0
            ? 'First demo provider bid received'
            : `${S.bids.length} demo provider bids received`
          );
      }, 1200 + index * 1600);
  });
  } catch (e) { S.busy = false; toast(e.message); render(); }
}

async function acceptBid() {
  const bid = S.bids[S.sel];

  S.busy = true;
  S.error = null;
  render();

  try {
    // 1. Record the customer’s approval of this bid and exact total.
    const approval = await api(
      'POST',
      `/api/jobs/${S.job.id}/approve`,
      { bidId: bid.id }
    );

    // 2. Create the automatic-capture Hyperswitch payment.
    const payment = await api(
      'POST',
      `/api/jobs/${S.job.id}/pay`,
      { approvalId: approval.approvalId }
    );

    if (!payment.clientSecret) {
      throw new Error('Hyperswitch did not return a client secret.');
    }

    const total = approval.breakdown.totalAmount;

    $('modal').innerHTML = `
      <div class="veil">
        <div class="sheet"
             role="dialog"
             aria-modal="true"
             aria-label="Confirm booking">

          <div class="grab"></div>

          <h2>Book ${esc(approval.provider.name)}</h2>

          <p class="sub">
            Your approved total is charged now. Swoop reserves the captured
            funds for job completion or cancellation.
          </p>

          <div class="breakdown">
            <div>
              <span>${esc(approval.provider.trade)}</span>
              <span class="mono">
                ${fmt(approval.breakdown.bidAmount)}
              </span>
            </div>

            <div>
              <span>Swoop service fee (7.5%)</span>
              <span class="mono">
                ${fmt(approval.breakdown.feeAmount)}
              </span>
            </div>

            <div class="tot">
              <span>Total charged and reserved</span>
              <span class="mono">${fmt(total)}</span>
            </div>
          </div>

          <div id="payslot"
               style="margin-top:var(--s4);min-height:80px">
            <div class="skel" style="height:46px"></div>
          </div>

          <div id="payerr"></div>

          <button class="btn" id="paybtn" disabled>
            Preparing…
          </button>

          <button class="btn btn-ghost" onclick="closeModal()">
            Not yet
          </button>
        </div>
      </div>`;

    $('payslot').innerHTML = '';

    const confirmFn = await mountPayment(
      payment.clientSecret,
      'payslot'
    );

    $('paybtn').disabled = false;
    $('paybtn').textContent = `Pay ${fmt(total)} and book`;

    $('paybtn').onclick = async () => {
      $('paybtn').disabled = true;
      $('paybtn').textContent = 'Processing payment…';
      $('payerr').innerHTML = '';

      try {
        // 3. Customer confirms the payment through Hyperswitch.
        await confirmFn();

        // 4. Server retrieves and verifies the external payment.
        const result = await api(
          'POST',
          `/api/jobs/${S.job.id}/reconcile`,
          {}
        );

        if (result.status !== 'verified') {
          const reason =
            result.reason ||
            result.discrepancyReason ||
            'Payment confirmation is still pending.';

          throw new Error(reason);
        }

        closeModal();

        await loadJob(S.job.id);
        await refresh();

        S.chat = [{
          me: false,
          state: 'RESERVED',
          text:
            `Hi — I accepted your ${S.job.service.toLowerCase()} job. ` +
            `I haven't started travelling yet.`,
        }];

        S.busy = false;
        go('track');

        toast(
          `${esc(approval.provider.name.split(' ')[0])} is booked. ` +
          `${fmt(total)} was charged and reserved for this job.`
        );
      } catch (err) {
        $('payerr').innerHTML = `
          <div class="note bad">
            <b>${esc(err.message)}</b><br>
            Your job has not been confirmed. Try again or choose another payment method.
          </div>`;

        $('paybtn').disabled = false;
        $('paybtn').textContent = `Pay ${fmt(total)} and book`;
      }
    };
  } catch (err) {
    S.error = err.message;
    toast(err.message);
  } finally {
    S.busy = false;
    render();
  }
}

function providerMessageForState(state) {
  const firstName =
    acceptedBid()?.provider_name?.split(' ')[0] || 'Your provider';

  const messages = {
    EN_ROUTE:
      `${firstName}: I’m on my way now. You can follow my progress on the map.`,

    ARRIVED:
      `${firstName}: I’ve arrived at the job location. I’ll knock in a moment.`,

    IN_PROGRESS:
      `${firstName}: I’ve started working on the job.`,

    COMPLETED:
      `${firstName}: The work is complete. Please review everything when you’re ready.`,
  };

  return messages[state] || null;
}

async function advance() {
  S.busy = true; render();
  try {
    const action = S.job.state === 'IN_PROGRESS' ? 'complete' : 'advance';
    const r = await api(
    'POST',
    `/api/jobs/${S.job.id}/${action}`,
    {}
    );
    await loadJob(S.job.id); await refresh(); S.busy = false;
    const providerMessage = providerMessageForState(r.state);

    if (
      providerMessage &&
      !S.chat.some(message => message.state === r.state)
    ) {
    S.chat.push({
      me: false,
      state: r.state,
      text: providerMessage,
    });
  }
    if (r.state === 'EN_ROUTE') {
      S.chat.push({ me: false, text: 'On my way now, about 20 minutes out.' });
      clearInterval(S.iv);
      S.iv = setInterval(() => {
        if (S.job?.state !== 'EN_ROUTE') return clearInterval(S.iv);
        S.van.x += (70 - S.van.x) * .3; S.van.y += (26 - S.van.y) * .3;
        S.pings++; S.eta = Math.max(1, S.eta - 2);
        if (S.screen === 'track') render();
      }, 1200);
    }
    if (r.state === 'ARRIVED') { S.van = { x: 70, y: 26 }; S.eta = 0; }
    if (r.state === 'IN_PROGRESS') {
      clearInterval(S.iv);
    }
    if (r.state === 'COMPLETED') { clearInterval(S.iv); return go('review'); }
    render(); say(STATE_LABEL[r.state]);
  } catch (e) { S.busy = false; toast(e.message); render(); }
}

function askCancel() {
  const t = tier(S.job.state);
  const bid = acceptedBid();
  const total = bid?.totalAmount ?? 0;

  const retainedAmount =
    S.job.state === 'IN_PROGRESS'
      ? total
      : ['EN_ROUTE', 'ARRIVED'].includes(S.job.state)
        ? (S.config.penalty ?? 3000)
        : 0;

  const walletCredit = Math.max(0, total - retainedAmount);

  const retainedLabel =
    S.job.state === 'IN_PROGRESS'
      ? 'Amount retained'
      : 'Provider compensation';

  const confirmLabel =
    S.job.state === 'IN_PROGRESS'
      ? 'Cancel with no wallet credit'
      : retainedAmount > 0
        ? 'Cancel and retain $30'
        : 'Cancel and return the full amount';

  $('modal').innerHTML = `
    <div class="veil">
      <div
        class="sheet"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm cancellation">

        <div class="grab"></div>

        <h2>Cancel this job?</h2>
        <p class="sub">${t.detail}</p>

        <div class="breakdown">
          <div>
            <span>Originally charged</span>
            <span class="mono">${fmt(total)}</span>
          </div>

          <div>
            <span>${retainedLabel}</span>
            <span class="mono ${retainedAmount > 0 ? 'neg' : ''}">
              ${fmt(retainedAmount)}
            </span>
          </div>

          <div class="tot">
            <span>Credited to your Swoop wallet</span>
            <span class="mono ${walletCredit > 0 ? 'pos' : ''}">
              ${fmt(walletCredit)}
            </span>
          </div>
        </div>

        <button
          class="btn ${retainedAmount > 0 ? 'btn-danger' : ''}"
          onclick="confirmCancel()">
          ${confirmLabel}
        </button>

        <button class="btn btn-ghost" onclick="closeModal()">
          Go back
        </button>
      </div>
    </div>`;
}

async function confirmCancel() {
  try {
    const r = await api('POST', `/api/jobs/${S.job.id}/cancel`, {});
    clearInterval(S.iv); closeModal(); await refresh(); S.job = null; go('jobs');
    toast(r.charged ? `Cancelled. ${fmt(r.charged)} charged.` : 'Cancelled. Nothing was charged.');
  } catch (e) { toast(e.message); }
}

async function finish() {
  S.busy = true; render();
  try {
    if (S.tip > 0) await api('POST', `/api/jobs/${S.job.id}/tip`, {
      amount: S.tip,
      tipId: crypto.randomUUID(),
    });
    await refresh(); S.busy = false; S.job = null; S.rating = 0;
    const tipped = S.tip; S.tip = 0; go('jobs');
    toast(tipped ? `Review posted and ${fmt(tipped)} tipped.` : 'Review posted. Thanks.');
  } catch (e) { S.busy = false; toast(e.message); render(); }
}
function sendMsg() {
  const el = $('msg'), t = el.value.trim(); if (!t) return;
  S.chat.push({ me: true, text: t }); el.value = ''; render();
  setTimeout(() => {
    S.chat.push({ me: false, text: S.job?.state === 'EN_ROUTE' ? "Traffic's light, still on track." : "Sure — I'll take a look." });
    if (S.screen === 'track') render();
  }, 1100);
}
async function openJob(id) {
  await loadJob(id);
  go(S.job.state === 'OPEN_FOR_BIDS' ? 'bids' : S.job.state === 'COMPLETED' ? 'jobs' : 'track');
}

/* ----------------------------------------------------------------- shell */
function go(s) { S.screen = s; render(); window.scrollTo(0, 0); }
function renderSafely(fn) {
  try { return fn(); }
  catch (err) {
    console.error('render failed', err);
    return `<div class="screen"><div class="empty"><h3>Something went wrong</h3>
      <p class="sub">We couldn't draw this screen. Your money is unaffected.</p>
      <button class="btn btn-ghost" onclick="go('home')">Back to home</button></div></div>`;
  }
}

function render() {
  if (!USER) {                      // signed out: no wallet strip, no tab bar
    $('strip').hidden = true; $('nav').hidden = true;
    $('view').innerHTML = renderSafely(V.login);
    return;
  }
  $('view').innerHTML = S.loading
    ? `<div class="screen"><div class="skel" style="height:26px;width:70%"></div>
       <div class="skel" style="height:12px;width:50%;margin-top:12px"></div></div>`
    : renderSafely(V[S.screen] || V.home);
  $('nav').hidden = S.loading;
  $('nav').innerHTML = [['home', 'Home', 'Home'], ['jobs', 'Jobs', 'Jobs'], ['wallet', 'Wallet', 'Wallet']]
    .map(([k, l, ic]) => `<button aria-current="${S.screen === k || (k === 'jobs' && ['bids', 'track', 'review'].includes(S.screen))}"
      onclick="go('${k}')">${icon(ic)}<span>${l}</span></button>`).join('');
  renderStrip();
  const c = $('chat'); if (c) c.scrollTop = c.scrollHeight;
}

Object.assign(window, { go, pick, openTopup, closeModal, submitJob, acceptBid, advance,
  askCancel, confirmCancel, finish, sendMsg, openJob, withdraw, signOut, hint, S });

(async function boot() {
  try {
    S.config = await api('GET', '/api/config');
    if (USER) await refresh(); else S.loading = false;
  } catch (e) {
    S.loading = false;
    const message = e.status >= 500
      ? 'Swoop API is unavailable. Configure DATABASE_URL in Vercel, then redeploy.'
      : 'Could not reach Swoop. Check the deployment and your connection.';
    toast(message);
  }
  render();
})();
