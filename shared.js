// ============================================================
// shared.js
// ============================================================
// Code used identically across multiple pages (dashboard, budget, profile,
// shifts) lives here instead of being copy-pasted into each page's own
// script file. Load this BEFORE the page's own script:
//
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="shared.js"></script>
//   <script src="dashboard.js"></script>   <!-- (or budget.js / myprofile.js / shifts.js) -->
//
// Each page still creates its own `supabaseClient` (since the Supabase
// URL/key setup lives at the top of each page's own script) — the
// functions here just reference that global once it exists, which is fine
// since they're only ever CALLED after the page's script has already run.

// Turns a plain number like 12.5 into a display string like "$12.50"
function formatMoney(n) {
    return '$' + n.toFixed(2);
}

// ============================================================
// OVERTIME + LUNCH BREAK CALCULATION
// ============================================================
// If you ever change the overtime rate, the weekly threshold, or how lunch
// breaks factor into pay, this is now the ONLY place that needs updating —
// every page that includes shared.js picks up the change automatically.

const OVERTIME_WEEKLY_THRESHOLD = 40; // hours per week before overtime kicks in
const OVERTIME_MULTIPLIER = 1.5;      // "time and a half" pay rate for overtime hours

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
// it's based on TOTAL hours across a whole week, for a single job. If you
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

    // Step 1: group shifts by "job + week" — overtime is tracked separately
    // per job, per week (two different jobs don't share an overtime pool,
    // and hours reset every new week).
    const groups = new Map();
    shifts.forEach(s => {
        const weekKey = s.job_id + '_' + getWeekStartDate(new Date(s.clock_in)).getTime();
        if (!groups.has(weekKey)) groups.set(weekKey, []);
        groups.get(weekKey).push(s);
    });

    // Step 2: for each job+week group, walk through shifts in chronological
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
