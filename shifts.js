const SUPABASE_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4ProG0sjTH1-DCh9f5QsUg_L85xilyM';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


let currentUser = null;
let userJobs = [];
let allShifts = [];
let periodStats = new Map(); 
let openPeriodKeys = new Set(); 
let periodsRenderedOnce = false;

// ---- Biweekly pay period helpers ----
let PERIOD_ANCHOR = new Date(2024, 0, 7); 
let usingFallbackAnchor = true;

function getPayPeriodStart(date) {
    // count whole calendar days, not milliseconds, so the clock change can't move a shift into the wrong period
    const msPerDay = 1000 * 60 * 60 * 24;
    const dayNumber = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / msPerDay;
    const daysSinceAnchor = dayNumber(date) - dayNumber(PERIOD_ANCHOR);
    const periodsSinceAnchor = Math.floor(daysSinceAnchor / 14);
    const periodStart = new Date(PERIOD_ANCHOR);
    periodStart.setDate(periodStart.getDate() + (periodsSinceAnchor * 14));
    return periodStart;
}

function formatDateRange(start, end) {
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    const lastDay = new Date(end);
    lastDay.setDate(lastDay.getDate() - 1); // end is exclusive
    return start.toLocaleDateString(undefined, opts) + ' – ' + lastDay.toLocaleDateString(undefined, opts);
}

// ---- Init ----
async function init() {
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error || !user) {
        window.location.href = 'login.html';
        return;
    }
    currentUser = user;

    const savedAnchor = user.user_metadata?.pay_period_start;
    if (savedAnchor) {
        PERIOD_ANCHOR = new Date(savedAnchor + 'T00:00:00');
        usingFallbackAnchor = false;
    }

    renderAnchorHint();
    renderPeriodInfo();
    await loadJobs();
    await loadShifts();
}

function renderAnchorHint() {
    const section = document.querySelector('.shift-periods-section');
    const existing = document.getElementById('anchor-hint');
    if (existing) existing.remove();

    if (usingFallbackAnchor) {
        const hint = document.createElement('p');
        hint.id = 'anchor-hint';
        hint.className = 'anchor-hint';
        hint.innerHTML = 'Pay periods below use a placeholder start date. Set your real <a href="myprofile.html">Pay Period Start Date in Profile</a> to line these up with your actual paychecks.';
        section.insertBefore(hint, section.querySelector('#periods-list'));
    }
}

function renderPeriodInfo() {
    const section = document.querySelector('.shift-periods-section');
    const existing = document.getElementById('period-info');
    if (existing) existing.remove();

    const currentStart = getPayPeriodStart(new Date());
    const currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + 14);

    const weekday = PERIOD_ANCHOR.toLocaleDateString(undefined, { weekday: 'long' });
    const anchorText = PERIOD_ANCHOR.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

    const info = document.createElement('p');
    info.id = 'period-info';
    info.className = 'anchor-hint';
    info.textContent = 'Pay periods start every other ' + weekday + ' (counting from ' + anchorText + '). '
        + 'Current pay period: ' + formatDateRange(currentStart, currentEnd) + '.';
    section.insertBefore(info, section.querySelector('#periods-list'));
}

async function loadJobs() {
    const { data: jobs } = await supabaseClient
        .from('jobs')
        .select('*')
        .eq('user_id', currentUser.id);

    userJobs = jobs || [];

    const select = document.getElementById('add-shift-job');
    select.innerHTML = '';

    if (userJobs.length === 0) {
        select.innerHTML = '<option value="">No jobs yet — add one in User Info</option>';
        return;
    }

    userJobs.forEach(job => {
        const opt = document.createElement('option');
        opt.value = job.id;
        opt.textContent = job.job_title + ' ($' + job.hourly_wage + '/hr)';
        select.appendChild(opt);
    });
}

// ---- Load + group shifts ----
async function loadShifts() {
    const { data, error } = await supabaseClient
        .from('shifts')
        .select('*, jobs(job_title, hourly_wage, company)')
        .eq('user_id', currentUser.id)
        .order('clock_in', { ascending: false });

    if (error) {
        document.getElementById('periods-list').textContent = 'Could not load shifts.';
        return;
    }

    allShifts = data || [];
    await renderPeriods();
}

async function renderPeriods() {
    const container = document.getElementById('periods-list');
    container.innerHTML = '';

    periodStats = new Map();

    if (allShifts.length === 0) {
        container.textContent = 'No shifts logged yet.';
        renderPeriodSummary();
        return;
    }

    const periods = new Map();
    allShifts.forEach(shift => {
        const periodStart = getPayPeriodStart(new Date(shift.clock_in));
        const key = periodStart.getTime();
        if (!periods.has(key)) periods.set(key, { start: periodStart, shifts: [] });
        periods.get(key).shifts.push(shift);
    });

    // overtime is computed once over ALL shifts so a week that spans two pay periods stays correct
    const breaksByShiftId = await fetchBreaksByShiftId(allShifts.map(s => s.id));
    const shiftPayMap = computeShiftPayWithOvertime(allShifts, breaksByShiftId);

    const sortedPeriods = Array.from(periods.values()).sort((a, b) => b.start - a.start);

    if (!periodsRenderedOnce) {
        openPeriodKeys.add(getPayPeriodStart(new Date()).getTime());
        if (sortedPeriods.length > 0) openPeriodKeys.add(sortedPeriods[0].start.getTime());
        periodsRenderedOnce = true;
    }

    sortedPeriods.forEach(period => {
        const periodEnd = new Date(period.start);
        periodEnd.setDate(periodEnd.getDate() + 14);

        const periodEl = document.createElement('div');
        periodEl.className = 'pay-period';

        let periodTotal = 0;
        let periodHours = 0;
        let periodShiftCount = 0;
        period.shifts.forEach(s => {
            if (s.clock_out) {
                periodTotal += shiftPayMap.get(s) || 0;
                periodHours += getNetHours(s, breaksByShiftId);
                periodShiftCount++;
            }
        });

        const periodKey = period.start.getTime();
        periodStats.set(periodKey, { total: periodTotal, hours: periodHours, shiftCount: periodShiftCount });
        periodEl.dataset.key = periodKey;
        periodEl.classList.toggle('collapsed', !openPeriodKeys.has(periodKey));

        const periodHeader = document.createElement('div');
        periodHeader.className = 'pay-period-header';
        periodHeader.innerHTML = `
            <span class="period-range">${formatDateRange(period.start, periodEnd)}</span>
            <span class="period-total">${formatMoney(periodTotal)}</span>
        `;
        periodEl.appendChild(periodHeader);

        periodHeader.addEventListener('click', () => {
            const nowClosed = periodEl.classList.toggle('collapsed');
            if (nowClosed) openPeriodKeys.delete(periodKey);
            else openPeriodKeys.add(periodKey);
        });

        period.shifts
            .sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in))
            .forEach(shift => {
                periodEl.appendChild(buildShiftRow(shift, shiftPayMap, breaksByShiftId));
            });

        container.appendChild(periodEl);
    });

    renderPeriodSummary();
}

function getNetHours(shift, breaksByShiftId) {
    const rawHours = (new Date(shift.clock_out) - new Date(shift.clock_in)) / (1000 * 60 * 60);
    const shiftBreaks = (breaksByShiftId && breaksByShiftId.get(shift.id)) || [];
    const breakHours = shiftBreaks.reduce((sum, b) => {
        if (!b.break_end) return sum;
        return sum + (new Date(b.break_end) - new Date(b.break_start)) / (1000 * 60 * 60);
    }, 0);
    return Math.max(0, rawHours - breakHours);
}

// ---- Top card + last 6 pay periods bars ----
function renderPeriodSummary() {
    const currentStart = getPayPeriodStart(new Date());
    const currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + 14);

    const previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - 14);

    const empty = { total: 0, hours: 0, shiftCount: 0 };
    const current = periodStats.get(currentStart.getTime()) || empty;
    const previous = periodStats.get(previousStart.getTime()) || empty;

    document.getElementById('hero-amount').textContent = formatMoney(current.total);
    document.getElementById('hero-range').textContent = formatDateRange(currentStart, currentEnd);
    document.getElementById('hero-hours').textContent = current.hours.toFixed(2);
    document.getElementById('hero-shifts').textContent = current.shiftCount;
    document.getElementById('hero-average').textContent = formatMoney(current.hours > 0 ? current.total / current.hours : 0);

    const delta = document.getElementById('hero-delta');
    delta.className = 'hero-delta';
    delta.textContent = '';
    if (previous.total > 0) {
        const ahead = current.total >= previous.total;
        delta.classList.add(ahead ? 'up' : 'down');
        delta.textContent = (ahead ? '▲ ' : '▼ ') + 'Last period: ' + formatMoney(previous.total);
    }

    renderPeriodBars(currentStart);
}

function buildPeriodBar(bar, best, isCurrent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rd-bar' + (isCurrent ? ' today' : '');
    button.dataset.key = bar.start.getTime();
    button.title = 'Pay period starting ' + bar.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ': ' + formatMoney(bar.total);

    const amount = document.createElement('span');
    amount.className = 'rd-amount';
    amount.textContent = bar.total > 0 ? '$' + Math.round(bar.total) : '';

    const track = document.createElement('span');
    track.className = 'rd-track';
    const fill = document.createElement('span');
    fill.className = 'rd-fill';
    fill.style.height = best > 0 ? Math.max(bar.total / best * 100, bar.total > 0 ? 6 : 0) + '%' : '0%';
    track.appendChild(fill);

    const name = document.createElement('span');
    name.className = 'rd-day';
    name.textContent = bar.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    button.appendChild(amount);
    button.appendChild(track);
    button.appendChild(name);
    return button;
}

function renderPeriodBars(currentStart) {
    const list = document.getElementById('period-bars');
    list.innerHTML = '';

    const bars = [];
    for (let back = 5; back >= 0; back--) {
        const start = new Date(currentStart);
        start.setDate(start.getDate() - 14 * back);
        const stats = periodStats.get(start.getTime());
        bars.push({ start: start, total: stats ? stats.total : 0 });
    }

    const best = Math.max(0, ...bars.map(bar => bar.total));
    bars.forEach((bar, index) => list.appendChild(buildPeriodBar(bar, best, index === bars.length - 1)));
}

document.getElementById('period-bars').addEventListener('click', (event) => {
    const bar = event.target.closest('.rd-bar');
    if (!bar) return;

    const periodEl = document.querySelector('.pay-period[data-key="' + bar.dataset.key + '"]');
    if (!periodEl) return;

    periodEl.classList.remove('collapsed');
    openPeriodKeys.add(Number(bar.dataset.key));
    periodEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function buildShiftRow(shift, shiftPayMap, breaksByShiftId) {
    const row = document.createElement('div');
    row.className = 'shift-row';
    row.id = 'shift-row-' + shift.id;

    renderShiftViewMode(row, shift, shiftPayMap, breaksByShiftId);
    return row;
}

function renderShiftViewMode(row, shift, shiftPayMap, breaksByShiftId) {
    const jobTitle = shift.jobs ? shift.jobs.job_title : '(deleted job)';
    const clockInDisplay = new Date(shift.clock_in).toLocaleString();
    const clockOutDisplay = shift.clock_out
        ? new Date(shift.clock_out).toLocaleString()
        : 'Still clocked in';

    const shiftBreaks = (breaksByShiftId && breaksByShiftId.get(shift.id)) || [];
    const breakHours = shiftBreaks.reduce((sum, b) => {
        if (!b.break_end) return sum;
        return sum + (new Date(b.break_end) - new Date(b.break_start)) / (1000 * 60 * 60);
    }, 0);
    const breakNote = breakHours > 0 ? ` <span class="break-note">(−${breakHours.toFixed(2)}h lunch)</span>` : '';

    let hoursDisplay = '—';
    let payDisplay = '—';
    if (shift.clock_out) {
        const rawHours = (new Date(shift.clock_out) - new Date(shift.clock_in)) / (1000 * 60 * 60);
        const netHours = Math.max(0, rawHours - breakHours);
        hoursDisplay = netHours.toFixed(2) + ' hrs' + breakNote;
        payDisplay = formatMoney(shiftPayMap.get(shift) || 0);
    }

    row.classList.toggle('active-shift', !shift.clock_out);

    row.innerHTML = `
        <span class="shift-job">${escapeHtml(jobTitle)}</span>
        <span class="shift-clockin">${clockInDisplay}</span>
        <span class="shift-clockout">${clockOutDisplay}</span>
        <span class="shift-hours">${hoursDisplay}</span>
        <span class="shift-pay">${payDisplay}</span>
        <span class="shift-actions">
            <button type="button" class="edit-shift-btn">Edit</button>
            <button type="button" class="delete-shift-btn">Delete</button>
        </span>
    `;

    row.querySelector('.edit-shift-btn').addEventListener('click', () => renderShiftEditMode(row, shift));
    row.querySelector('.delete-shift-btn').addEventListener('click', () => deleteShift(shift.id));
}

function toDatetimeLocalValue(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderShiftEditMode(row, shift) {
    const jobTitle = shift.jobs ? shift.jobs.job_title : '(deleted job)';

    row.innerHTML = `
        <span class="shift-job">${escapeHtml(jobTitle)}</span>
        <span class="shift-edit-fields">
            <label>In: <input type="datetime-local" class="edit-clockin" value="${toDatetimeLocalValue(shift.clock_in)}"></label>
            <label>Out: <input type="datetime-local" class="edit-clockout" value="${toDatetimeLocalValue(shift.clock_out)}"></label>
        </span>
        <span class="shift-edit-actions">
            <button type="button" class="save-shift-btn">Save</button>
            <button type="button" class="cancel-shift-btn">Cancel</button>
        </span>
        <p class="edit-shift-status form-status"></p>
    `;

    row.querySelector('.save-shift-btn').addEventListener('click', () => saveShiftEdit(row, shift));
    row.querySelector('.cancel-shift-btn').addEventListener('click', () => loadShifts());
}

async function saveShiftEdit(row, shift) {
    const statusEl = row.querySelector('.edit-shift-status');
    const clockInValue = row.querySelector('.edit-clockin').value;
    const clockOutValue = row.querySelector('.edit-clockout').value;

    if (!clockInValue) {
        statusEl.textContent = 'Clock-in time is required.';
        return;
    }

    const clockInDate = new Date(clockInValue);
    const clockOutDate = clockOutValue ? new Date(clockOutValue) : null;

    if (clockOutDate && clockOutDate <= clockInDate) {
        statusEl.textContent = 'Clock-out time must be after clock-in time.';
        return;
    }

    if (clockOutDate) {
        const hours = (clockOutDate - clockInDate) / (1000 * 60 * 60);
        if (hours > 24) {
            statusEl.textContent = 'That shift is longer than 24 hours — please double-check the times.';
            return;
        }
    }

    const { error } = await supabaseClient
        .from('shifts')
        .update({
            clock_in: clockInDate.toISOString(),
            clock_out: clockOutDate ? clockOutDate.toISOString() : null
        })
        .eq('id', shift.id);

    if (error) {
        statusEl.textContent = 'Error: ' + error.message;
        return;
    }

    await loadShifts();
}

async function deleteShift(shiftId) {
    const confirmed = confirm('Delete this shift? This cannot be undone.');
    if (!confirmed) return;

    const { error } = await supabaseClient.from('shifts').delete().eq('id', shiftId);

    if (error) {
        alert('Error deleting shift: ' + error.message);
        return;
    }

    await loadShifts();
}

document.getElementById('add-shift-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById('add-shift-status');
    statusEl.textContent = '';

    const jobId = document.getElementById('add-shift-job').value;
    const clockInValue = document.getElementById('add-shift-clockin').value;
    const clockOutValue = document.getElementById('add-shift-clockout').value;

    if (!jobId) {
        statusEl.textContent = 'Please select a job.';
        return;
    }
    if (!clockInValue || !clockOutValue) {
        statusEl.textContent = 'Both clock-in and clock-out times are required.';
        return;
    }

    const clockInDate = new Date(clockInValue);
    const clockOutDate = new Date(clockOutValue);

    if (clockOutDate <= clockInDate) {
        statusEl.textContent = 'Clock-out time must be after clock-in time.';
        return;
    }

    const hours = (clockOutDate - clockInDate) / (1000 * 60 * 60);
    if (hours > 24) {
        statusEl.textContent = 'That shift is longer than 24 hours — please double-check the times.';
        return;
    }

    const { error } = await supabaseClient
        .from('shifts')
        .insert([{
            user_id: currentUser.id,
            job_id: jobId,
            clock_in: clockInDate.toISOString(),
            clock_out: clockOutDate.toISOString()
        }]);

    if (error) {
        statusEl.textContent = 'Error: ' + error.message;
        return;
    }

    document.getElementById('add-shift-form').reset();
    await loadShifts();
});

// ---- Nav logout ----
document.getElementById('nav-logout-btn').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
});

function setNavHeight() {
    const nav = document.querySelector('.main-nav');
    if (nav) document.documentElement.style.setProperty('--nav-h', nav.offsetHeight + 'px');
}

setNavHeight();
window.addEventListener('resize', setNavHeight);

function applyTheme(isDark) {
    document.body.classList.toggle('dark', isDark);
    document.getElementById('theme-toggle').textContent = isDark ? '☀️' : '🌙';
}

document.getElementById('theme-toggle').addEventListener('click', () => {
    const goDark = !document.body.classList.contains('dark');
    applyTheme(goDark);

    try { localStorage.setItem('theme', goDark ? 'dark' : 'light'); } catch (e) { /* private window, just don't remember it */ }
});

applyTheme(document.body.classList.contains('dark'));

document.getElementById('jump-add').addEventListener('click', () => {
    document.querySelector('.add-shift-section details').open = true;
});

const addShiftBox = document.querySelector('.add-shift-section details');
try {
    if (localStorage.getItem('open-addshift') === 'yes') addShiftBox.open = true;
} catch (e) { /* keep it closed */ }
addShiftBox.addEventListener('toggle', () => {
    try { localStorage.setItem('open-addshift', addShiftBox.open ? 'yes' : 'no'); } catch (e) { /* ignore */ }
});

// ---- Count-up numbers ----
function parseMoneyText(text) {
    const cleaned = String(text).replace(/[$,%\s]/g, '');
    if (cleaned === '' || isNaN(cleaned)) return null;
    return parseFloat(cleaned);
}

function rollMoney(element, from, to) {
    const ticket = (element.__ticket || 0) + 1;
    element.__ticket = ticket;
    const startTime = performance.now();

    function frame(now) {
        if (element.__ticket !== ticket) return;

        const progress = Math.max(0, Math.min((now - startTime) / 650, 1));
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = from + (to - from) * eased;

        element.__shown = value;
        element.__written = formatMoney(value);
        element.textContent = element.__written;
        if (progress < 1) requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

function handleMoneyChange(element) {
    if (element.textContent === element.__written) return;

    const target = parseMoneyText(element.textContent);
    if (target === null) return;

    const from = element.__shown !== undefined ? element.__shown : 0;

    if (Math.abs(target - from) < 1) {
        element.__ticket = (element.__ticket || 0) + 1;
        element.__shown = target;
        return;
    }

    rollMoney(element, from, target);
}

['hero-amount', 'hero-average'].forEach(id => {
    const element = document.getElementById(id);
    new MutationObserver(() => handleMoneyChange(element)).observe(element, { childList: true, characterData: true, subtree: true });
});

window.addEventListener('error', e => { const l = document.getElementById('periods-list'); if (l && l.textContent === 'Loading...') l.textContent = 'Page error: ' + e.message; });
init().catch(error => {
    console.error('Shifts page failed to load:', error);
    const list = document.getElementById('periods-list');
    if (list) list.textContent = 'Could not load shifts: ' + (error && error.message ? error.message : error);
});
