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
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysSinceAnchor = Math.floor((date - PERIOD_ANCHOR) / msPerDay);
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
        .select('*, jobs(job_title, hourly_wage)')
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

    if (allShifts.length === 0) {
        container.textContent = 'No shifts logged yet.';
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

    sortedPeriods.forEach(period => {
        const periodEnd = new Date(period.start);
        periodEnd.setDate(periodEnd.getDate() + 14);

        const periodEl = document.createElement('div');
        periodEl.className = 'pay-period';

        // period totals: sum of every completed shift's overtime-aware pay in this period
        let periodTotal = 0;
        period.shifts.forEach(s => {
            if (s.clock_out) periodTotal += shiftPayMap.get(s) || 0;
        });

        const periodHeader = document.createElement('div');
        periodHeader.className = 'pay-period-header';
        periodHeader.innerHTML = `
            <span class="period-range">${formatDateRange(period.start, periodEnd)}</span>
            <span class="period-total">${formatMoney(periodTotal)}</span>
        `;
        periodEl.appendChild(periodHeader);

        // shifts within the period, most recent first
        period.shifts
            .sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in))
            .forEach(shift => {
                periodEl.appendChild(buildShiftRow(shift, shiftPayMap, breaksByShiftId));
            });

        container.appendChild(periodEl);
    });
}

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

init();