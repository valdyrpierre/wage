// ============================================================
// SUPABASE SETUP
// ============================================================
// TODO: replace with your actual Supabase project values
const SUPABASE_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4ProG0sjTH1-DCh9f5QsUg_L85xilyM';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// GLOBAL STATE
// ============================================================
let currentUser = null;
let userJobs = [];
let allShifts = []; // every shift belonging to the user, refreshed after every change
let periodStats = new Map(); // pay period start (timestamp) -> { total, hours, shiftCount }, used by the top card and the bars
let openPeriodKeys = new Set(); // the pay periods left open, so editing a shift does not close them
let periodsRenderedOnce = false; // the first time, the current and the newest period start open

// NOTE: formatMoney, OVERTIME_WEEKLY_THRESHOLD, OVERTIME_MULTIPLIER,
// getWeekStartDate, computeShiftPayWithOvertime, and fetchBreaksByShiftId
// all now live in shared.js (loaded before this file), so the pay shown
// here always agrees with dashboard.js, budget.js, and myprofile.js.

// ============================================================
// BIWEEKLY PAY PERIOD HELPERS
// ============================================================
// PERIOD_ANCHOR determines where pay period boundaries fall. It's set in
// init() from the "Pay Period Start Date" saved on the Profile page (stored
// in Supabase user_metadata), so periods line up with the person's actual
// pay schedule. If they haven't set one yet, we fall back to an arbitrary
// reference date and show a hint pointing them to the Profile page.
let PERIOD_ANCHOR = new Date(2024, 0, 7); // fallback reference date until we know the real one
let usingFallbackAnchor = true;

// Given any Date, returns the start (midnight) of the 14-day pay period
// that date falls into, based on the current PERIOD_ANCHOR.
function getPayPeriodStart(date) {
    // we count whole calendar days (not milliseconds), so the clock change in March and November
    // can never push a shift near midnight into the wrong pay period
    const msPerDay = 1000 * 60 * 60 * 24;
    const dayNumber = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / msPerDay;
    const daysSinceAnchor = dayNumber(date) - dayNumber(PERIOD_ANCHOR);
    // integer-divide by 14, then floor, to correctly handle dates before the anchor too
    const periodsSinceAnchor = Math.floor(daysSinceAnchor / 14);
    const periodStart = new Date(PERIOD_ANCHOR);
    periodStart.setDate(periodStart.getDate() + (periodsSinceAnchor * 14));
    return periodStart;
}

function formatDateRange(start, end) {
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    const lastDay = new Date(end);
    lastDay.setDate(lastDay.getDate() - 1); // end is exclusive, so show the actual last day of the period
    return start.toLocaleDateString(undefined, opts) + ' – ' + lastDay.toLocaleDateString(undefined, opts);
}

// ============================================================
// INIT
// ============================================================
async function init() {
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error || !user) {
        window.location.href = 'login.html';
        return;
    }
    currentUser = user;

    // Use the person's saved pay period start date if they've set one.
    const savedAnchor = user.user_metadata?.pay_period_start;
    if (savedAnchor) {
        // Parse as local midnight (not UTC) so the date shown matches what
        // they actually picked in the date field, regardless of timezone.
        PERIOD_ANCHOR = new Date(savedAnchor + 'T00:00:00');
        usingFallbackAnchor = false;
    }

    renderAnchorHint();
    renderPeriodInfo();
    await loadJobs();
    await loadShifts();
}

// Shows a one-line hint above the pay periods list if the person hasn't
// set a real pay period start date yet, so the (currently arbitrary)
// groupings don't quietly mislead them.
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

// Shows one line above the shift list with the pay period schedule the app is using right now,
// and the current pay period, so it is easy to see if it matches the real pay schedule
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

// ============================================================
// LOAD + GROUP SHIFTS
// ============================================================
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

    // group every shift into its biweekly pay period
    const periods = new Map(); // key: period start timestamp -> { start, shifts: [] }
    allShifts.forEach(shift => {
        const periodStart = getPayPeriodStart(new Date(shift.clock_in));
        const key = periodStart.getTime();
        if (!periods.has(key)) periods.set(key, { start: periodStart, shifts: [] });
        periods.get(key).shifts.push(shift);
    });

    // fetch lunch break data for every shift up front, then compute
    // overtime-aware pay for every shift, once against the FULL shift
    // list (not per-period) so week boundaries that straddle two pay periods
    // still get calculated correctly
    const breaksByShiftId = await fetchBreaksByShiftId(allShifts.map(s => s.id));
    const shiftPayMap = computeShiftPayWithOvertime(allShifts, breaksByShiftId);

    // show most recent pay period first
    const sortedPeriods = Array.from(periods.values()).sort((a, b) => b.start - a.start);

    // the first time the page loads, the current pay period and the newest one start open and the rest are closed
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

        // period totals: sum of every completed shift's overtime-aware pay in this period
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

        // clicking the header opens or closes the period, and the page remembers it
        periodHeader.addEventListener('click', () => {
            const nowClosed = periodEl.classList.toggle('collapsed');
            if (nowClosed) openPeriodKeys.delete(periodKey);
            else openPeriodKeys.add(periodKey);
        });

        // shifts within the period, most recent first
        period.shifts
            .sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in))
            .forEach(shift => {
                periodEl.appendChild(buildShiftRow(shift, shiftPayMap, breaksByShiftId));
            });

        container.appendChild(periodEl);
    });

    renderPeriodSummary();
}

// hours worked in one finished shift, after taking out the unpaid lunch breaks
function getNetHours(shift, breaksByShiftId) {
    const rawHours = (new Date(shift.clock_out) - new Date(shift.clock_in)) / (1000 * 60 * 60);
    const shiftBreaks = (breaksByShiftId && breaksByShiftId.get(shift.id)) || [];
    const breakHours = shiftBreaks.reduce((sum, b) => {
        if (!b.break_end) return sum;
        return sum + (new Date(b.break_end) - new Date(b.break_start)) / (1000 * 60 * 60);
    }, 0);
    return Math.max(0, rawHours - breakHours);
}

// ============================================================
// TOP CARD + LAST 6 PAY PERIODS BARS
// ============================================================
// first it finds the current pay period and the one before it, then it fills the big number,
// the "last period" note and the three small boxes, then it draws the bars
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

    // the arrow is green when this period is already at or above the whole last period
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

// builds one bar button for the "last 6 pay periods" strip
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

// tapping a bar opens that pay period in the list and scrolls to it
document.getElementById('period-bars').addEventListener('click', (event) => {
    const bar = event.target.closest('.rd-bar');
    if (!bar) return;

    const periodEl = document.querySelector('.pay-period[data-key="' + bar.dataset.key + '"]');
    if (!periodEl) return; // no shifts in that pay period

    periodEl.classList.remove('collapsed');
    openPeriodKeys.add(Number(bar.dataset.key));
    periodEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ============================================================
// SHIFT ROW (view mode + edit mode)
// ============================================================
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

    // total unpaid lunch time logged against this shift (closed-out breaks only)
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
        <span class="shift-job">${jobTitle}</span>
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

// Converts a stored ISO timestamp into the "YYYY-MM-DDTHH:mm" format that
// <input type="datetime-local"> expects, using the browser's local time
// (so the person edits the time they actually see, not a UTC offset).
function toDatetimeLocalValue(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderShiftEditMode(row, shift) {
    const jobTitle = shift.jobs ? shift.jobs.job_title : '(deleted job)';

    row.innerHTML = `
        <span class="shift-job">${jobTitle}</span>
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
    row.querySelector('.cancel-shift-btn').addEventListener('click', () => loadShifts()); // simplest way back to a clean view
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

    // basic sanity check: can't clock out before you clocked in
    if (clockOutDate && clockOutDate <= clockInDate) {
        statusEl.textContent = 'Clock-out time must be after clock-in time.';
        return;
    }

    // guard against an absurdly long shift from a typo (e.g. wrong day picked)
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

// ============================================================
// ADD A SHIFT MANUALLY (covers "forgot to clock in entirely")
// ============================================================
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

// ============================================================
// NAV LOGOUT
// ============================================================
document.getElementById('nav-logout-btn').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
});

// ============================================================
// FINANCE LAYER (dark / light theme, count-up numbers, sticky bar)
// same look as the dashboard and the budget page
// ============================================================

// the jump bar sticks right under the top menu, so it needs to know how tall that menu is
function setNavHeight() {
    const nav = document.querySelector('.main-nav');
    if (nav) document.documentElement.style.setProperty('--nav-h', nav.offsetHeight + 'px');
}

setNavHeight();
window.addEventListener('resize', setNavHeight);

// ---------- THEME (dark / light) ----------
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

// the "Add a Shift" link in the sticky bar also opens the form
document.getElementById('jump-add').addEventListener('click', () => {
    document.querySelector('.add-shift-section details').open = true;
});

// remembers if the Add a Shift form was left open or closed
const addShiftBox = document.querySelector('.add-shift-section details');
try {
    if (localStorage.getItem('open-addshift') === 'yes') addShiftBox.open = true;
} catch (e) { /* keep it closed */ }
addShiftBox.addEventListener('toggle', () => {
    try { localStorage.setItem('open-addshift', addShiftBox.open ? 'yes' : 'no'); } catch (e) { /* ignore */ }
});

// ---------- COUNT-UP NUMBERS ----------
// when a money number changes it rolls from the old value to the new one instead of jumping
function parseMoneyText(text) {
    const cleaned = String(text).replace(/[$,%\s]/g, '');
    if (cleaned === '' || isNaN(cleaned)) return null;
    return parseFloat(cleaned);
}

// every roll gets a ticket number, so if a newer number arrives the older roll stops
function rollMoney(element, from, to) {
    const ticket = (element.__ticket || 0) + 1;
    element.__ticket = ticket;
    const startTime = performance.now();

    function frame(now) {
        if (element.__ticket !== ticket) return;

        const progress = Math.min((now - startTime) / 650, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // fast at first, slow at the end
        const value = from + (to - from) * eased;

        element.__shown = value;
        element.__written = formatMoney(value);
        element.textContent = element.__written; // remembered, so the watcher knows this write is ours
        if (progress < 1) requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

function handleMoneyChange(element) {
    if (element.textContent === element.__written) return; // our own roll wrote this

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

// if anything inside init breaks, say what it was on the page instead of leaving "Loading..." forever
window.addEventListener('error', e => { const l = document.getElementById('periods-list'); if (l && l.textContent === 'Loading...') l.textContent = 'Page error: ' + e.message; });
init().catch(error => {
    console.error('Shifts page failed to load:', error);
    const list = document.getElementById('periods-list');
    if (list) list.textContent = 'Could not load shifts: ' + (error && error.message ? error.message : error);
});
