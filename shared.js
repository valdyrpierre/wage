
// Makes text safe to place inside an HTML template string. Anything a user can type
// (company names, job titles) goes through this first, so "<img onerror=...>" shows up
// as plain text instead of running as code.
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Turns a plain number like 12.5 into a display string like "$12.50"
function formatMoney(n) {
    // thousands commas ($4,975.93) so big money reads like a finance app
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================
// OVERTIME + LUNCH BREAK CALCULATION
// ============================================================
// If you ever change the overtime rate, the weekly threshold, or how lunch
// breaks factor into pay, this is now the ONLY place that needs updating —
// every page that includes shared.js picks up the change automatically.

const OVERTIME_WEEKLY_THRESHOLD = 40; // hours per week before overtime kicks in
const OVERTIME_MULTIPLIER = 1.5;      // "time and a half" pay rate for overtime hours

// Overtime is counted per COMPANY, because hours at two different employers are never added together.
// Two jobs with the same company name (ignoring capital letters and extra spaces) share one overtime pool.
// A job with no company saved yet counts as its own company, so old jobs keep working.
function getEmployerKey(company, jobId) {
    if (company && company.trim()) {
        return 'c:' + company.trim().toLowerCase();
    }
    return 'j:' + jobId;
}

// Given any Date, returns a new Date representing the Sunday that starts
// that date's calendar week (time reset to midnight). Used to group shifts
// into "weeks" — overtime resets every week, so we need to know which week
// each shift belongs to.
function getWeekStartDate(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - d.getDay()); // getDay() is 0 for Sunday, so this rewinds to Sunday
    return d;
}

// Takes a list of completed shifts (each with clock_in, clock_out, job_id,
// and the linked job's hourly_wage) and calculates how much each individual
// shift actually paid, accounting for overtime AND unpaid lunch breaks.
//
// Why overtime needs this treatment: it isn't based on one shift's length —
// it's based on TOTAL hours across a whole week, for a single company. If you
// worked 35 hours earlier in the week and then work a 10-hour shift, only
// the last 5 of those 10 hours count as overtime (35 + 5 = 40 regular, 5 OT).
//
// Why lunch breaks are subtracted: a logged lunch break is unpaid, so its
// duration comes off the shift's raw clock-in-to-clock-out length before
// any pay is calculated.
//
// breaksByShiftId: optional Map from shift.id -> array of break rows for
// that shift (from fetchBreaksByShiftId below). Safe to omit if a page
// doesn't care about breaks.
//
// Returns a Map where each key is a shift object and the value is that
// shift's calculated pay (regular + overtime combined, breaks excluded).
function computeShiftPayWithOvertime(shifts, breaksByShiftId) {
    breaksByShiftId = breaksByShiftId || new Map();
    const payByShift = new Map();

    // Step 1: group shifts by "company + week" — overtime is tracked separately
    // per company, per week (two different companies don't share an overtime pool,
    // and hours reset every new week).
    const groups = new Map();
    shifts.forEach(s => {
        const weekKey = getEmployerKey(s.jobs && s.jobs.company, s.job_id) + '_' + getWeekStartDate(new Date(s.clock_in)).getTime();
        if (!groups.has(weekKey)) groups.set(weekKey, []);
        groups.get(weekKey).push(s);
    });

    // Step 2: for each company+week group, walk through shifts in chronological
    // order, keeping a running total of hours worked so far that week.
    // Whatever pushes the running total past 40 hours gets paid at the
    // overtime rate instead of the regular rate.
    groups.forEach(group => {
        group.sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));

        let cumulativeHours = 0; // hours worked this week so far, before the current shift
        group.forEach(s => {
            if (!s.clock_out) return; // skip still-active shifts — no completed hours to count yet

            const rawHours = (new Date(s.clock_out) - new Date(s.clock_in)) / (1000 * 60 * 60);

            // subtract any (unpaid) lunch break time logged against this shift
            const shiftBreaks = breaksByShiftId.get(s.id) || [];
            const breakHours = shiftBreaks.reduce((sum, b) => {
                if (!b.break_end) return sum; // ignore a break that was never closed out
                return sum + (new Date(b.break_end) - new Date(b.break_start)) / (1000 * 60 * 60);
            }, 0);
            const hours = Math.max(0, rawHours - breakHours);

            const wage = s.jobs ? parseFloat(s.jobs.hourly_wage) : 0;

            const hoursBefore = cumulativeHours;
            cumulativeHours += hours;

            // How many of THIS shift's hours are still "regular" (under 40 for the week)?
            // Math.min caps it at the shift's own length; Math.max(0, ...) prevents a
            // negative number once we're already past 40 hours for the week.
            const regularHours = Math.max(0, Math.min(hours, OVERTIME_WEEKLY_THRESHOLD - hoursBefore));
            const overtimeHours = hours - regularHours; // whatever's left over counts as overtime

            const shiftPay = (regularHours * wage) + (overtimeHours * wage * OVERTIME_MULTIPLIER);
            payByShift.set(s, shiftPay);
        });
    });

    return payByShift;
}

// Fetches every break row for a given set of shift ids and groups them into
// a Map keyed by shift_id, ready to hand to computeShiftPayWithOvertime.
// Relies on a global `supabaseClient` already existing (created by the
// page's own script before this function is ever called).
async function fetchBreaksByShiftId(shiftIds) {
    const map = new Map();
    if (!shiftIds || shiftIds.length === 0) return map;

    const { data, error } = await supabaseClient
        .from('breaks')
        .select('shift_id, break_start, break_end')
        .in('shift_id', shiftIds);

    if (error || !data) return map;

    data.forEach(b => {
        if (!map.has(b.shift_id)) map.set(b.shift_id, []);
        map.get(b.shift_id).push(b);
    });
    return map;
}


// ============================================================
// AUTO-LOGOUT AFTER INACTIVITY
// ============================================================
// Protects a shared or stolen device: if nobody touches the page for 30 minutes, the user is signed out.
// A warning banner appears 2 minutes before. Activity in ANY open tab keeps all tabs signed in,
// because the last-activity time is kept in localStorage. Real clock time is checked (not a long
// timer), so a laptop that slept for an hour signs out the moment it wakes up.
(function () {
    const IDLE_LIMIT_MS = 30 * 60 * 1000;
    const WARNING_MS = 2 * 60 * 1000; // warn this long before the limit
    const STORAGE_KEY = 'lastActivity';
    let banner = null;
    let signingOut = false;

    function getClient() {
        if (window.supabaseClient) return window.supabaseClient;
        return typeof supabaseClient !== 'undefined' ? supabaseClient : null;
    }

    let memoryLastActivity = 0; // this tab's own record, used when localStorage is blocked
    function storedActivity() {
        try { return Number(localStorage.getItem(STORAGE_KEY)) || 0; }
        catch (e) { return 0; }
    }

    function markActivity() {
        memoryLastActivity = Date.now();
        try { localStorage.setItem(STORAGE_KEY, String(memoryLastActivity)); } catch (e) { /* private window */ }
        hideBanner();
    }

    function lastActivity() {
        return Math.max(storedActivity(), memoryLastActivity);
    }

    function showBanner(secondsLeft) {
        if (!banner) {
            banner = document.createElement('div');
            banner.setAttribute('role', 'alert');
            banner.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;'
                + 'background:#7c2d12;color:#fff;padding:12px 20px;border-radius:10px;font:600 14px system-ui,sans-serif;'
                + 'box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:calc(100vw - 32px);text-align:center';
            document.body.appendChild(banner);
        }
        const minutes = Math.floor(secondsLeft / 60);
        const seconds = String(secondsLeft % 60).padStart(2, '0');
        banner.textContent = 'You will be signed out in ' + minutes + ':' + seconds + ' because of inactivity. Move your mouse or press a key to stay signed in.';
    }

    function hideBanner() {
        if (banner) { banner.remove(); banner = null; }
    }

    async function signOutForInactivity() {
        if (signingOut) return;
        signingOut = true;
        const client = getClient();
        try { if (client) await client.auth.signOut(); } catch (e) { /* leave anyway */ }
        try { sessionStorage.removeItem('assistantChat'); sessionStorage.removeItem('assistantOpen'); } catch (e) { }
        window.location.href = 'login.html?timeout=1';
    }

    function check() {
        if (signingOut) return;
        const idleMs = Date.now() - lastActivity();
        if (idleMs >= IDLE_LIMIT_MS) {
            signOutForInactivity();
        } else if (idleMs >= IDLE_LIMIT_MS - WARNING_MS) {
            showBanner(Math.ceil((IDLE_LIMIT_MS - idleMs) / 1000));
        } else {
            hideBanner();
        }
    }

    async function start() {
        const client = getClient();
        if (!client) return;
        const { data } = await client.auth.getSession();
        if (!data || !data.session) return; // not logged in, nothing to protect

        // the page being opened is itself a sign of life, unless the stored time is already far too old
        // (a returning user after a long break must still be signed out)
        const stored = storedActivity();
        if (!stored || Date.now() - stored < IDLE_LIMIT_MS) markActivity();

        let lastMove = 0;
        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach(name => {
            window.addEventListener(name, () => {
                const now = Date.now();
                if (now - lastMove < 1000) return; // at most one write per second
                lastMove = now;
                markActivity();
            }, { passive: true });
        });

        check();
        setInterval(check, 1000);
        document.addEventListener('visibilitychange', check);
    }

    document.addEventListener('DOMContentLoaded', start);
})();
