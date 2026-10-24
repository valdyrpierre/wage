
// Turns a plain number like 12.5 into a display string like "$12.50"
function formatMoney(n) {
    // thousands commas ($4,975.93) so big money reads like a finance app
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}


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
function computeShiftPayWithOvertime(shifts, breaksByShiftId) {
    breaksByShiftId = breaksByShiftId || new Map();
    const payByShift = new Map();

    // Step 1: group shifts by "company + week" — overtime is tracked separately
    const groups = new Map();
    shifts.forEach(s => {
        const weekKey = getEmployerKey(s.jobs && s.jobs.company, s.job_id) + '_' + getWeekStartDate(new Date(s.clock_in)).getTime();
        if (!groups.has(weekKey)) groups.set(weekKey, []);
        groups.get(weekKey).push(s);
    });

    // Step 2: for each company+week group, walk through shifts in chronological
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
