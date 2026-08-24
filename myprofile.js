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
// These hold data we fetch once and reuse across multiple functions,
// so we don't have to re-query Supabase every time we need it.
let currentUser = null; // the logged-in user's Supabase auth object (id, email, metadata, etc.)
let userJobs = [];      // array of this user's rows from the "jobs" table

// NOTE: formatMoney, OVERTIME_WEEKLY_THRESHOLD, OVERTIME_MULTIPLIER,
// getWeekStartDate, computeShiftPayWithOvertime, and fetchBreaksByShiftId
// all now live in shared.js (loaded before this file), so this page's
// "Income This Month" figure always agrees with dashboard.js, budget.js,
// and shifts.js — they all use the exact same functions now.

// ============================================================
// INIT — runs once when the page loads
// ============================================================
async function init() {
    // Check if someone is actually logged in. If not, bounce them to the login page —
    // this page should never be visible to a logged-out visitor.
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error || !user) {
        window.location.href = 'login.html';
        return;
    }
    currentUser = user;

    await loadProfileInfo();
    await loadJobsForEditing();
}

// ============================================================
// PROFILE INFO DISPLAY (top section of the page)
// ============================================================
async function loadProfileInfo() {
    // Supabase doesn't have a built-in "name" field on the user object,
    // so we store/read it from user_metadata instead (a flexible JSON
    // field Supabase provides for exactly this kind of custom data).
    const name = currentUser.user_metadata?.full_name || '(not set)';
    document.getElementById('profile-name').textContent = 'Name: ' + name;
    document.getElementById('profile-email').textContent = 'Email: ' + currentUser.email;

    // Pre-fill the "Update Info" form below with the user's current values,
    // so they're editing their existing info rather than starting from blank fields.
    document.getElementById('update-name').value = currentUser.user_metadata?.full_name || '';
    document.getElementById('update-email').value = currentUser.email;
    document.getElementById('update-pay-period-start').value = currentUser.user_metadata?.pay_period_start || '';

    // Pull all jobs belonging to this user from the "jobs" table.
    const { data: jobs } = await supabaseClient
        .from('jobs')
        .select('*')
        .eq('user_id', currentUser.id);

    userJobs = jobs || [];

    const titleText = userJobs.length > 0
        ? userJobs.map(j => j.job_title).join(', ') // e.g. "Cashier, Server"
        : '(no jobs added yet)';
    document.getElementById('profile-job-title').textContent = 'Job Title(s): ' + titleText;

    const income = await computeIncomeThisMonth();
    document.getElementById('profile-income').textContent = 'Income This Month: ' + formatMoney(income);
}

// Calculates total income (wages + commission) for the current calendar month.
// This is the same calculation used on the budget page, so the numbers agree
// everywhere in the app.
async function computeIncomeThisMonth() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // We fetch starting from the Sunday that begins monthStart's week (not from
    // monthStart itself). Why? Because if the 1st of the month falls in the
    // middle of a week, we need that week's earlier shifts too, in order to
    // correctly calculate whether later shifts in that same week hit overtime.
    const fetchFrom = getWeekStartDate(monthStart);

    const { data: shifts } = await supabaseClient
        .from('shifts')
        .select('id, job_id, clock_in, clock_out, jobs(hourly_wage)') // jobs(hourly_wage) pulls in the linked job's wage; id needed to look up breaks
        .eq('user_id', currentUser.id)
        .not('clock_out', 'is', null) // only count shifts that have actually been clocked out of
        .gte('clock_in', fetchFrom.toISOString())
        .lt('clock_in', monthEnd.toISOString());

    // Fetch any logged lunch breaks for these shifts (unpaid, so they're
    // subtracted from each shift's hours), then run every shift through the
    // overtime calculator so each shift's pay reflects whether it pushed the
    // user over 40 hrs/week for its job.
    const breaksByShiftId = await fetchBreaksByShiftId((shifts || []).map(s => s.id));
    const shiftPayMap = computeShiftPayWithOvertime(shifts || [], breaksByShiftId);

    // Now sum up ONLY the shifts that actually fall within this calendar month
    // (remember: we fetched a few extra "before the month started" shifts above,
    // purely to get the overtime math right — we don't want to count their pay here).
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

    return wageTotal + commissionTotal;
}

// ============================================================
// UPDATE NAME / EMAIL / PASSWORD
// ============================================================
document.getElementById('update-form').addEventListener('submit', async (e) => {
    e.preventDefault(); // stop the browser's default "reload the page" form behavior
    const statusEl = document.getElementById('update-status');
    statusEl.textContent = '';

    const name = document.getElementById('update-name').value.trim();
    const email = document.getElementById('update-email').value.trim();
    const password = document.getElementById('update-password').value;
    const payPeriodStart = document.getElementById('update-pay-period-start').value; // "YYYY-MM-DD" or empty

    // ---- validation before contacting Supabase ----

    if (name.length > 100) {
        statusEl.textContent = 'Name is too long (max 100 characters).';
        statusEl.style.color = '#dc2626';
        return;
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email && !emailPattern.test(email)) {
        statusEl.textContent = 'Please enter a valid email address.';
        statusEl.style.color = '#dc2626';
        return;
    }

    // password is optional here (blank = "don't change it"), but if the user
    // did type something, it needs to meet Supabase's minimum length
    if (password && password.length < 6) {
        statusEl.textContent = 'New password must be at least 6 characters long.';
        statusEl.style.color = '#dc2626';
        return;
    }

    // Build the update request. We only include email/password in the payload
    // if the user actually changed/entered something — otherwise Supabase would
    // try to "update" the email to the same value, or set a blank password.
    // pay_period_start is stored in user_metadata alongside full_name — it's
    // read by shifts.js to line up biweekly pay period groupings correctly.
    const updatePayload = { data: { full_name: name, pay_period_start: payPeriodStart || null } };
    if (email && email !== currentUser.email) updatePayload.email = email;
    if (password) updatePayload.password = password;

    const { data, error } = await supabaseClient.auth.updateUser(updatePayload);

    if (error) {
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.style.color = '#dc2626'; // red
        return;
    }

    // Supabase returns the updated user object — refresh our local copy
    // so the rest of the page reflects the change immediately.
    currentUser = data.user;
    statusEl.textContent = 'Saved!';
    statusEl.style.color = '#0f766e'; // teal (matches the site's success color)
    document.getElementById('update-password').value = ''; // clear the password field for security
    await loadProfileInfo(); // re-render the top section with the new info
});

// ============================================================
// EDIT / DELETE JOBS
// ============================================================
// Populates the "Select a job" dropdown with the user's jobs, and wires it up
// so picking a different job loads that job's info into the edit form below.
async function loadJobsForEditing() {
    const select = document.getElementById('job-select');
    select.innerHTML = ''; // clear out any old options before rebuilding the list

    if (userJobs.length === 0) {
        select.innerHTML = '<option value="">No jobs yet</option>';
        document.getElementById('edit-job-title').value = '';
        document.getElementById('edit-job-wage').value = '';
        return;
    }

    userJobs.forEach(job => {
        const opt = document.createElement('option');
        opt.value = job.id;           // the actual value submitted/read from the dropdown
        opt.textContent = job.job_title; // what the user sees in the dropdown
        select.appendChild(opt);
    });

    // Default to showing the first job's info in the edit form
    fillJobEditForm(userJobs[0]);

    // When the user picks a different job from the dropdown, swap the form's
    // contents to match that job instead.
    select.addEventListener('change', () => {
        const job = userJobs.find(j => String(j.id) === String(select.value));
        if (job) fillJobEditForm(job);
    });
}

// Fills the "Edit Jobs" form fields with a specific job's current values.
function fillJobEditForm(job) {
    document.getElementById('edit-job-title').value = job.job_title;
    document.getElementById('edit-job-wage').value = job.hourly_wage;
}

// Saves changes to whichever job is currently selected in the dropdown.
document.getElementById('job-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById('job-edit-status');
    const jobId = document.getElementById('job-select').value;

    if (!jobId) {
        statusEl.textContent = 'No job selected.';
        statusEl.style.color = '#dc2626';
        return;
    }

    const newTitle = document.getElementById('edit-job-title').value.trim();
    const newWage = parseFloat(document.getElementById('edit-job-wage').value);
    const MAX_REASONABLE_WAGE = 1000;

    if (!newTitle) {
        statusEl.textContent = 'Job title cannot be empty.';
        statusEl.style.color = '#dc2626';
        return;
    }

    if (isNaN(newWage) || newWage <= 0) {
        statusEl.textContent = 'Hourly wage must be a number greater than 0.';
        statusEl.style.color = '#dc2626';
        return;
    }

    if (newWage > MAX_REASONABLE_WAGE) {
        statusEl.textContent = `$${newWage}/hr seems too high — please double-check it.`;
        statusEl.style.color = '#dc2626';
        return;
    }

    const { error } = await supabaseClient
        .from('jobs')
        .update({ job_title: newTitle, hourly_wage: newWage })
        .eq('id', jobId); // only update the one row matching this job's id

    if (error) {
        statusEl.textContent = 'Error: ' + error.message;
        statusEl.style.color = '#dc2626';
        return;
    }

    statusEl.textContent = 'Job updated!';
    statusEl.style.color = '#0f766e';
    // Refresh both the top profile summary (job title list, income) and the
    // dropdown/edit form, since the job's info just changed.
    await loadProfileInfo();
    await loadJobsForEditing();
});

// Deletes whichever job is currently selected in the dropdown.
document.getElementById('delete-job-btn').addEventListener('click', async () => {
    const jobId = document.getElementById('job-select').value;
    if (!jobId) return;

    // Double-check with the user before doing something irreversible —
    // deleting a job also cascades to delete its linked shifts/commissions
    // (because of the "on delete cascade" set up in the database schema).
    const confirmed = confirm('Delete this job? This will also remove any shifts and commissions linked to it.');
    if (!confirmed) return;

    const { error } = await supabaseClient.from('jobs').delete().eq('id', jobId);

    if (error) {
        alert('Error deleting job: ' + error.message);
        return;
    }

    await loadProfileInfo();
    await loadJobsForEditing();
});

// ============================================================
// LOGOUT
// ============================================================
// Both the nav bar's logout button and the one down in the Danger Zone
// section do the exact same thing — just two convenient places to reach it.
document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabaseClient.auth.signOut(); // clears the local session/token
    window.location.href = 'login.html';
});

document.getElementById('nav-logout-btn').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
});

// ============================================================
// DELETE ACCOUNT (wipes the user's data, then signs them out)
// ============================================================
// Note: this does NOT delete the actual login credentials (email/password)
// from Supabase's auth system — that requires a privileged "service role"
// API call that can't safely run in browser-side JavaScript. This button
// removes everything the user actually see/use in the app, and logs them out.
document.getElementById('delete-account-btn').addEventListener('click', async () => {
    // Two separate confirmations, since this is destructive and irreversible.
    const firstConfirm = confirm('This will permanently delete all your jobs, shifts, commissions, and bills. Continue?');
    if (!firstConfirm) return;

    const secondConfirm = confirm('Are you absolutely sure? This cannot be undone.');
    if (!secondConfirm) return;

    // Delete in this specific order because of foreign key relationships:
    // bills/commissions/shifts all reference a job or user, so we clear
    // those out before removing the jobs themselves.
    await supabaseClient.from('bills').delete().eq('user_id', currentUser.id);
    await supabaseClient.from('commissions').delete().eq('user_id', currentUser.id);
    await supabaseClient.from('shifts').delete().eq('user_id', currentUser.id);
    await supabaseClient.from('jobs').delete().eq('user_id', currentUser.id);

    await supabaseClient.auth.signOut();
    alert('Your data has been deleted and you have been logged out.');
    window.location.href = 'login.html';
});

// Kick everything off once the script loads.
init();