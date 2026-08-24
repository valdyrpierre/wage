// ============================================================
// SUPABASE SETUP
// ============================================================
// TODO: replace with your actual Supabase project values
// (Project Settings > API in your Supabase dashboard)
const SUPABASE_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4ProG0sjTH1-DCh9f5QsUg_L85xilyM';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// GLOBAL STATE
// ============================================================
let currentUser = null; // the logged-in user's Supabase auth object
let allBills = [];      // every bill row belonging to this user, refreshed after every add/edit/delete

// NOTE: formatMoney, OVERTIME_WEEKLY_THRESHOLD, OVERTIME_MULTIPLIER,
// getWeekStartDate, computeShiftPayWithOvertime, and fetchBreaksByShiftId
// all now live in shared.js (loaded before this file), so this page's
// "Earned This Month" figure always agrees with dashboard.js, myprofile.js,
// and shifts.js — they all use the exact same functions now.

// Returns today's date as a "YYYY-MM-DD" string, matching how Supabase
// stores "date" type columns (like bills.due_date, commissions.entry_date).
function todayStr() {
    return new Date().toISOString().split('T')[0];
}

// Returns the whole number of days between two dates (dateA - dateB).
// Used to figure out "3 days until due" / "2 days overdue" for the bill schedule.
function daysBetween(dateA, dateB) {
    const msPerDay = 1000 * 60 * 60 * 24;
    return Math.round((dateA - dateB) / msPerDay);
}

// Checks whether a date string (e.g. a bill's due_date) falls in the same
// calendar month/year as a reference Date. Used to filter "bills due this month".
function isSameMonth(dateStr, refDate) {
    const d = new Date(dateStr);
    return d.getFullYear() === refDate.getFullYear() && d.getMonth() === refDate.getMonth();
}

// ============================================================
// INIT — runs once when the page loads
// ============================================================
async function init() {
    // Check if someone is actually logged in. If not, bounce them to the login page.
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error || !user) {
        window.location.href = 'login.html';
        return;
    }
    currentUser = user;

    await loadIncomeThisMonth();
    await loadBills();
}

// ============================================================
// INCOME THIS MONTH
// ============================================================
// Calculates total income (wages + commission) for the current calendar month,
// and writes it directly into the "My Income" and summary boxes on the page.
// This mirrors the same wage + commission calculation used on the dashboard
// and profile pages, so the numbers agree everywhere in the app.
async function loadIncomeThisMonth() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // We fetch starting from the Sunday that begins monthStart's week (not from
    // monthStart itself). Why? If the 1st of the month falls mid-week, we still
    // need that week's earlier shifts in order to correctly calculate whether
    // later shifts in that same week hit the overtime threshold.
    const fetchFrom = getWeekStartDate(monthStart);

    const { data: shifts } = await supabaseClient
        .from('shifts')
        .select('id, job_id, clock_in, clock_out, jobs(hourly_wage)') // jobs(hourly_wage) pulls in the linked job's wage; id needed to look up breaks
        .eq('user_id', currentUser.id)
        .not('clock_out', 'is', null) // only count shifts that have actually been clocked out of
        .gte('clock_in', fetchFrom.toISOString())
        .lt('clock_in', monthEnd.toISOString());

    // Fetch any logged lunch breaks for these shifts (unpaid, so they get
    // subtracted from each shift's hours), then run every shift through the
    // overtime calculator so each shift's pay reflects whether it pushed the
    // user over 40 hrs/week for its job.
    const breaksByShiftId = await fetchBreaksByShiftId((shifts || []).map(s => s.id));
    const shiftPayMap = computeShiftPayWithOvertime(shifts || [], breaksByShiftId);

    // Now sum up ONLY the shifts that actually fall within this calendar month
    // (we fetched a few extra "before the month started" shifts above purely
    // to get the overtime math right — we don't want to count their pay here).
    let wageTotal = 0;
    (shifts || []).forEach(s => {
        const clockIn = new Date(s.clock_in);
        if (clockIn >= monthStart && clockIn < monthEnd) {
            wageTotal += shiftPayMap.get(s) || 0;
        }
    });

    // Add up any commission entries logged this month.
    const { data: commissions } = await supabaseClient
        .from('commissions')
        .select('amount, entry_date')
        .eq('user_id', currentUser.id)
        .gte('entry_date', monthStart.toISOString().split('T')[0])
        .lt('entry_date', monthEnd.toISOString().split('T')[0]);

    const commissionTotal = (commissions || []).reduce((sum, c) => sum + parseFloat(c.amount), 0);

    const incomeThisMonth = wageTotal + commissionTotal;

    // Update the page directly with the results.
    document.getElementById('summary-income').textContent = formatMoney(incomeThisMonth);
    document.getElementById('income-list').textContent =
        `Wages: ${formatMoney(wageTotal)}  •  Commission: ${formatMoney(commissionTotal)}`;

    // Also return the number, since renderSummary() below needs it for its
    // "% of bills covered" and "left to spend" calculations.
    return incomeThisMonth;
}

// ============================================================
// LOAD + RENDER BILLS
// ============================================================
// Fetches every bill belonging to the user, then re-renders all three
// bill-related sections (schedule, checklist, summary) from that fresh data.
async function loadBills() {
    const { data, error } = await supabaseClient
        .from('bills')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('due_date', { ascending: true }); // soonest-due bills appear first

    if (error) {
        document.getElementById('bill-schedules-list').textContent = 'Could not load bills.';
        document.getElementById('bill-checklist-list').textContent = 'Could not load bills.';
        return;
    }

    allBills = data || [];
    renderSchedules();
    renderChecklist();
    await renderSummary();
}

// Renders the "Bill Schedules" section — one row per bill, color-coded by
// urgency (overdue / due soon / paid / normal) based on today's date.
function renderSchedules() {
    const container = document.getElementById('bill-schedules-list');
    container.innerHTML = ''; // clear out the old rows before rebuilding

    if (allBills.length === 0) {
        container.textContent = 'No bills added yet.';
        return;
    }

    const today = new Date();

    allBills.forEach(bill => {
        const dueDate = new Date(bill.due_date);
        const daysUntil = daysBetween(dueDate, today);

        const row = document.createElement('div');
        row.className = 'bill-row';

        // Add a CSS class depending on the bill's status, so the stylesheet
        // can color-code it (green = paid, amber = due soon, red = overdue).
        if (bill.paid) {
            row.classList.add('paid');
        } else if (daysUntil < 0) {
            row.classList.add('overdue');
        } else if (daysUntil <= 5) {
            row.classList.add('due-soon');
        }

        // Build the human-readable status text shown on the right of each row.
        let statusText;
        if (bill.paid) {
            statusText = 'Paid';
        } else if (daysUntil < 0) {
            statusText = Math.abs(daysUntil) + ' day(s) overdue';
        } else if (daysUntil === 0) {
            statusText = 'Due today';
        } else {
            statusText = 'Due in ' + daysUntil + ' day(s)';
        }

        // If this bill is one installment of a split bill, show which part
        // it is (e.g. "Part 2 of 3") next to its name. If it's a recurring
        // bill instead, show a small "Recurring" badge.
        const labelPart = bill.split_label
            ? ` (${bill.split_label})`
            : (bill.is_recurring ? ' 🔁 Recurring' : '');

        row.innerHTML = `
            <span class="bill-name">${bill.name}${labelPart}</span>
            <span class="bill-amount">${formatMoney(parseFloat(bill.amount))}</span>
            <span class="bill-due">${dueDate.toLocaleDateString()}</span>
            <span class="bill-status">${statusText}</span>
            <button type="button" class="delete-bill-btn" data-bill-id="${bill.id}">Delete</button>
        `;
        container.appendChild(row);
    });

    // wire up every delete button now that they exist in the DOM
    container.querySelectorAll('.delete-bill-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteBill(btn.getAttribute('data-bill-id')));
    });
}

// Deletes a single bill. If that bill is part of a recurring series, asks
// whether to delete just this one occurrence or every future occurrence
// in the same series (identified by matching recurring_group).
async function deleteBill(billId) {
    const bill = allBills.find(b => String(b.id) === String(billId));
    if (!bill) return;

    const confirmed = confirm(`Delete "${bill.name}"?`);
    if (!confirmed) return;

    if (bill.is_recurring && bill.recurring_group) {
        const deleteAllFuture = confirm(
            'This bill repeats monthly. Click OK to delete this AND all future occurrences in the series, or Cancel to delete just this one.'
        );

        if (deleteAllFuture) {
            // delete this occurrence and every future one in the same series
            const { error } = await supabaseClient
                .from('bills')
                .delete()
                .eq('recurring_group', bill.recurring_group)
                .gte('due_date', bill.due_date);

            if (error) {
                alert('Error deleting bills: ' + error.message);
                return;
            }
            await loadBills();
            return;
        }
    }

    // default: just delete this single bill row
    const { error } = await supabaseClient.from('bills').delete().eq('id', billId);

    if (error) {
        alert('Error deleting bill: ' + error.message);
        return;
    }
    await loadBills();
}

// Renders the "Bill Checklist" section — one checkbox row per bill, so the
// user can mark bills as paid/unpaid directly.
function renderChecklist() {
    const container = document.getElementById('bill-checklist-list');
    container.innerHTML = '';

    if (allBills.length === 0) {
        container.textContent = 'No bills to check off yet.';
        return;
    }

    allBills.forEach(bill => {
        const row = document.createElement('label'); // <label> so clicking the text also toggles the checkbox
        row.className = 'checklist-row';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = bill.paid;
        // Whenever the checkbox is toggled, immediately save the change to Supabase.
        checkbox.addEventListener('change', () => toggleBillPaid(bill.id, checkbox.checked));

        const labelPart = bill.split_label ? ` (${bill.split_label})` : '';
        const text = document.createElement('span');
        text.textContent = `${bill.name}${labelPart} — ${formatMoney(parseFloat(bill.amount))} — due ${new Date(bill.due_date).toLocaleDateString()}`;

        row.appendChild(checkbox);
        row.appendChild(text);
        container.appendChild(row);
    });
}

// Updates a single bill's "paid" status in the database, then reloads
// everything so the schedule/checklist/summary all reflect the change.
async function toggleBillPaid(billId, paidValue) {
    const { error } = await supabaseClient
        .from('bills')
        .update({ paid: paidValue })
        .eq('id', billId);

    if (error) {
        alert('Could not update bill: ' + error.message);
        return;
    }

    await loadBills();
}

// ============================================================
// BUDGET SUMMARY
// ============================================================
// Fills in the top "Budget Summary" section: income earned this month,
// total bills due this month, what % of those bills are covered by what's
// been earned so far, and how much is left over to spend.
async function renderSummary() {
    const now = new Date();
    const incomeThisMonth = await loadIncomeThisMonth();

    // Only count bills whose due date falls in the current month —
    // a bill due next month shouldn't count against this month's income.
    const billsThisMonth = allBills.filter(b => isSameMonth(b.due_date, now));
    const totalBills = billsThisMonth.reduce((sum, b) => sum + parseFloat(b.amount), 0);

    // Avoid a divide-by-zero if there are no bills this month.
    const percentCovered = totalBills > 0 ? (incomeThisMonth / totalBills) * 100 : 0;
    const leftToSpend = incomeThisMonth - totalBills; // can go negative if bills exceed income

    document.getElementById('summary-bills').textContent = formatMoney(totalBills);
    document.getElementById('summary-percent').textContent = percentCovered.toFixed(0) + '%';
    document.getElementById('summary-left').textContent = formatMoney(leftToSpend);

    // Update the visual progress bar. We cap the fill width at 100% (a bar
    // can't visually go past full), but the number above it can still show
    // percentages over 100%.
    const fill = document.getElementById('summary-progress-fill');
    const clampedPercent = Math.min(percentCovered, 100);
    fill.style.width = clampedPercent + '%';
    // Switch the bar to a red "over budget" color if bills exceed income.
    fill.classList.toggle('over', leftToSpend < 0);
}

// ============================================================
// ADD BILL (with optional split into installments, or monthly recurrence)
// ============================================================

// Splitting and recurring don't make sense combined (splitting the SAME bill
// into installments AND repeating it every month gets confusing fast), so we
// keep them mutually exclusive: checking "Repeat monthly" disables the split
// dropdown, and picking a split disables the recurring checkbox.
const recurringCheckbox = document.getElementById('bill-recurring');
const recurringMonthsWrap = document.getElementById('recurring-months-wrap');
const splitSelect = document.getElementById('bill-split');

recurringCheckbox.addEventListener('change', () => {
    const isChecked = recurringCheckbox.checked;
    recurringMonthsWrap.style.display = isChecked ? 'block' : 'none';
    splitSelect.disabled = isChecked;
    if (isChecked) splitSelect.value = '1'; // reset split back to "Don't split"
});

splitSelect.addEventListener('change', () => {
    const isSplitting = splitSelect.value !== '1';
    recurringCheckbox.disabled = isSplitting;
    if (isSplitting) {
        recurringCheckbox.checked = false;
        recurringMonthsWrap.style.display = 'none';
    }
});

// Given a due date and how many months to add, returns a new due date on
// the same day-of-month, N months later — clamped to the last valid day of
// that month if needed (e.g. Jan 31 + 1 month becomes Feb 28, not Mar 3).
function addMonthsClamped(dateStr, monthsToAdd) {
    const original = new Date(dateStr);
    const targetMonthIndex = original.getMonth() + monthsToAdd;

    // creating a date with day=0 gives us the LAST day of the month before it,
    // which tells us how many days the target month actually has
    const lastDayOfTargetMonth = new Date(original.getFullYear(), targetMonthIndex + 1, 0).getDate();
    const clampedDay = Math.min(original.getDate(), lastDayOfTargetMonth);

    return new Date(original.getFullYear(), targetMonthIndex, clampedDay);
}

document.getElementById('add-bill-form').addEventListener('submit', async (e) => {
    e.preventDefault(); // stop the browser's default "reload the page" form behavior

    const statusEl = document.getElementById('bill-form-status');
    statusEl.textContent = '';

    const name = document.getElementById('bill-name').value.trim();
    const amount = parseFloat(document.getElementById('bill-amount').value);
    const dueDate = document.getElementById('bill-due-date').value;
    const splitCount = parseInt(document.getElementById('bill-split').value, 10);
    const isRecurring = document.getElementById('bill-recurring').checked;
    const recurringMonths = parseInt(document.getElementById('bill-recurring-months').value, 10) || 12;

    // ---- validation before building/inserting any rows ----
    const MAX_REASONABLE_AMOUNT = 1000000;

    if (!name) {
        statusEl.textContent = 'Please enter a bill name.';
        return;
    }

    if (isNaN(amount) || amount <= 0) {
        statusEl.textContent = 'Amount must be a number greater than 0.';
        return;
    }

    if (amount > MAX_REASONABLE_AMOUNT) {
        statusEl.textContent = 'That amount seems too high — please double-check it.';
        return;
    }

    if (!dueDate) {
        statusEl.textContent = 'Please choose a due date.';
        return;
    }

    if (isRecurring && (isNaN(recurringMonths) || recurringMonths < 1 || recurringMonths > 24)) {
        statusEl.textContent = 'Recurring months must be between 1 and 24.';
        return;
    }

    let rowsToInsert = [];

    if (isRecurring) {
        // Recurring bill: generate one row per month for the requested number
        // of months, all sharing a recurring_group id so they're recognized
        // as the same series (used later for "delete all future occurrences").
        const recurringGroup = crypto.randomUUID();

        for (let i = 0; i < recurringMonths; i++) {
            const occurrenceDate = addMonthsClamped(dueDate, i);

            rowsToInsert.push({
                user_id: currentUser.id,
                name: name,
                amount: amount, // recurring bills use the full amount each month (not divided, unlike splitting)
                due_date: occurrenceDate.toISOString().split('T')[0],
                paid: false,
                split_group: null,
                split_label: null,
                is_recurring: true,
                recurring_group: recurringGroup
            });
        }
    } else if (splitCount <= 1) {
        // No split, not recurring — just one bill row as entered.
        rowsToInsert.push({
            user_id: currentUser.id,
            name: name,
            amount: amount,
            due_date: dueDate,
            paid: false,
            split_group: null, // null means "not part of a split bill"
            split_label: null,
            is_recurring: false,
            recurring_group: null
        });
    } else {
        // Splitting into multiple installments. Each installment becomes its
        // own row in the "bills" table, sharing a common split_group id so
        // they can be recognized as belonging to the same original bill.
        const splitGroup = crypto.randomUUID(); // generates a unique id to link the installments together
        const splitAmount = Math.round((amount / splitCount) * 100) / 100; // round to the nearest cent
        const baseDate = new Date(dueDate);

        for (let i = 0; i < splitCount; i++) {
            const installmentDate = new Date(baseDate);
            installmentDate.setDate(installmentDate.getDate() + (i * 14)); // space installments 2 weeks apart

            rowsToInsert.push({
                user_id: currentUser.id,
                name: name,
                amount: splitAmount,
                due_date: installmentDate.toISOString().split('T')[0],
                paid: false,
                split_group: splitGroup,
                split_label: `Part ${i + 1} of ${splitCount}`, // e.g. "Part 1 of 3"
                is_recurring: false,
                recurring_group: null
            });
        }
    }

    // Insert all the rows (whether it's 1 row, several split installments,
    // or a dozen monthly recurring occurrences) in a single request.
    const { error } = await supabaseClient.from('bills').insert(rowsToInsert);

    if (error) {
        statusEl.textContent = 'Error adding bill: ' + error.message;
        return;
    }

    document.getElementById('add-bill-form').reset(); // clear the form for the next entry
    document.getElementById('recurring-months-wrap').style.display = 'none'; // hide the recurring options again after reset
    await loadBills(); // refresh everything so the new bill shows up immediately
});

// ============================================================
// NAV LOGOUT
// ============================================================
document.getElementById('nav-logout-btn').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
});

// Kick everything off once the script loads.
init();