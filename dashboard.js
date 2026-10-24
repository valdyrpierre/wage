// If anything breaks, show a red message at the top of the page. before this, a broken script
// just left the page stuck on "Loading..." or on $0.00 and nothing explained why
function showPageError(message)
{
    console.error('Dashboard error:', message);
    let banner = document.getElementById('page-error-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'page-error-banner';
        banner.style.cssText = 'background:#fee2e2;color:#991b1b;padding:10px 16px;font-size:0.9rem;border-bottom:1px solid #fca5a5;';
        document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.textContent = 'Dashboard error: ' + message + ' (if you just uploaded new files, make sure dashboard.html AND dashboard.js are both the newest versions, then press Ctrl+Shift+R)';
}
window.addEventListener('error', (e) => showPageError(e.message));
window.addEventListener('unhandledrejection', (e) => showPageError(e.reason && e.reason.message ? e.reason.message : String(e.reason)));

// adds a listener only if the element is on the page, so one missing element
// can't stop the whole script from loading
function addListener(id, eventName, handler)
{
    const element = document.getElementById(id);
    if (!element) {
        console.warn('dashboard.js: no element with id "' + id + '" on this page, skipping it');
        return;
    }
    element.addEventListener(eventName, handler);
}

// TODO: replace with your actual Supabase project values
        const SUPABASE_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_4ProG0sjTH1-DCh9f5QsUg_L85xilyM';
        const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        let currentUser = null;
        let userJob = null;
        let userJobs = []; // every job the user has (one per company)
        let shiftsErrorShown = false; // so the "could not load shifts" pop up only shows once, not every second
        let selectedJobId = null;
        let activeShift = null; // { id, job_id, clock_in }
        let activeBreak = null; // { id, break_start } — the currently-open lunch break, if any
        let liveTimerInterval = null;
        let totalsBase = {}; // before-tax totals from finished shifts + commission, for each period (day/week/month/year)
        let totalsRanges = {}; // start and end dates of each period, so we know which ones the active shift falls inside
        let todayBase = null; // what the user already earned TODAY from finished shifts and commission, across ALL jobs (null when viewing another date)
        let minutesBeforeThisShift = 0; // minutes already worked this week at the same company, before the running shift started
        let liveShiftWage = 0; // wage the active shift has earned so far, updated every second by the live timer
        let taxRate = 5; // the % the user types in the tax box. when "Show After Tax" is on, this % is taken out of the amount. starts at 5 (the Massachusetts rate)
        let summaryBase = null; // the Daily Summary's saved wage + commission for its date, plus the date range, so the live timer can add the running shift on top
        let recentDays = []; // the last 7 days for the bars in the top card: { date, amount }
        let showAfterTax = { "constantpay": false, "pay-section": false, "income-monthly-graph": false };
        let todaysCommissionByJob = {}; // job_id -> total commission logged today
        let monthlyChart = null;        // Chart.js instance, kept so we can update instead of recreate
        const MONTHS_BACK = 6;          // how many months of history to show
        let employment = null;          // employment info for the current user, if any
        // NOTE: formatMoney, OVERTIME_WEEKLY_THRESHOLD, OVERTIME_MULTIPLIER,
        // getWeekStartDate, computeShiftPayWithOvertime, and fetchBreaksByShiftId
        // all now live in shared.js (loaded before this file) so every page
        // uses the exact same overtime/break logic.

        function obtainCurrentUserInfo( firstname, lastname, email, userId ) 
        {
            // if we obtain the info successfully we inform the user by showing a pop up on the screen saying
            // - welcome back firstname lastname
            switch (true) {
                case !firstname:
                    return alert('Error: Missing firstname');
                case !lastname:
                    return alert('Error: Missing lastname');
                case !email:
                    return alert('Error: Missing email');
                case !userId:
                    return alert('Error: Missing userId');
                default:
                    currentUser = { firstname, lastname, email, userId };
                    return alert(`Welcome back ${firstname} ${lastname}`);
            }    
        }

        function getUserEmploymentInfo(userJob)
        {
            // first it will scan the database to see if the user has any employment info
            // if the user has employment info it will return the info
            // if the user has no employment info a pop up will come up
            // this pop up will ask the user to input his employment info

            switch (true) {
                case !userJob:
                    // the return will initiate the pop up
                    return alert('alert: No employment info found. Please input your employment info.');
                default:
                    return userJob;
            }
        }

        function todayStr() {
            // uses the LOCAL date (toISOString would give tomorrow's date after about 8pm Eastern)
            const d = new Date();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${d.getFullYear()}-${month}-${day}`;
        }

        // Parses a "YYYY-MM-DD" string (like the value from a date input) as
        // LOCAL midnight instead of UTC midnight. Using `new Date("2026-08-20")`
        // directly parses it as UTC, which in US timezones actually lands on
        // the evening of Aug 19 local time — causing the "day" picker to
        // silently roll back one day. This avoids that.
        function parseLocalDate(dateStr) {
            const [year, month, day] = dateStr.split('-').map(Number);
            return new Date(year, month - 1, day);
        }

        // ---------- INIT ----------
        async function init() {
            document.getElementById('view-date').value = todayStr();
            document.getElementById('commission-date').value = todayStr();

            // first we find out who is logged in
            const { data: { user }, error } = await supabaseClient.auth.getUser();
            if (error || !user) {
                window.location.href = 'login.html';
                return;
            }

            // the profile page saves ONE full_name, so we split it into firstname and lastname here
            const fullName = (user.user_metadata?.full_name || '').trim();
            const [firstname, ...otherNames] = fullName.split(' ');
            const lastname = otherNames.join(' ');

            // sign up does not ask for a name, so a new account has none yet. send them to the profile page to add it
            if (!firstname || !lastname) {
                alert('Please add your first and last name on the Profile page.');
                window.location.href = 'myprofile.html';
                return;
            }

            obtainCurrentUserInfo(firstname, lastname, user.email, user.id);
            if (!currentUser) return; // something was missing, the pop up already told the user
            document.getElementById('user-name').textContent = firstname + ' ' + lastname;

            // second we ask the database for ALL of the user's jobs (one for each company)
            const { data: jobs, error: jobsError } = await supabaseClient
                .from('jobs')
                .select('*')
                .eq('user_id', currentUser.userId)
                .order('created_at', { ascending: true });

            if (jobsError) {
                return alert('Error loading your jobs: ' + jobsError.message);
            }

            userJobs = jobs || [];
            userJob = getUserEmploymentInfo(userJobs[0]); // we start on the first job, and the drop down lets the user switch
            if (!userJob) {
                document.getElementById('job-title-display').textContent = 'No job info found';
                return;
            }
            selectedJobId = userJob.id;
            showJobInHeader();

            // third we load everything that needs the job
            await loadTodaysCommissions();
            await loadCommissionEntriesForDate(todayStr());
            await loadTodaysBreaks();
            await checkActiveShift();
            await refreshTotals(); // this now also sets the earnings box correctly on its own
            await renderMonthlyChart();
        }

        // hands back the job that is currently selected at the top of the page
        function getSelectedJob() {
            return userJob;
        }

        // the text for a job, like "Sonesta — Front Desk Associate". a job with no company just shows its title
        function jobLabel(job)
        {
            return job.company ? job.company + ' — ' + job.job_title : job.job_title;
        }

        // shows the selected job's name at the top, and fills the list of all the user's jobs.
        // the list opens when the user clicks on the job name
        function showJobInHeader()
        {
            const display = document.getElementById('job-title-display');
            display.textContent = userJob ? jobLabel(userJob) : 'No job info found';
            display.classList.toggle('clickable-job', userJobs.length > 0);
            renderJobsPanel();
        }

        // clicking the job name opens or closes the list of all the user's jobs
        addListener('job-title-display', 'click', () => {
            const panel = document.getElementById('jobs-panel');
            if (!panel || userJobs.length === 0) return;
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });

        // builds the list: one row for each job, with a Switch and a Delete button, and a link to add another job
        function renderJobsPanel()
        {
            const panel = document.getElementById('jobs-panel');
            if (!panel) return;

            panel.innerHTML = '';

            userJobs.forEach(job => {
                const row = document.createElement('div');
                row.className = 'jobs-panel-row';

                const isCurrent = userJob && job.id === userJob.id;

                const name = document.createElement('span');
                name.className = 'jobs-panel-name';
                name.textContent = jobLabel(job) + ' — $' + parseFloat(job.hourly_wage).toFixed(2) + '/hr';
                row.appendChild(name);

                const actions = document.createElement('span');
                actions.className = 'jobs-panel-actions';

                if (isCurrent) {
                    const currentTag = document.createElement('span');
                    currentTag.className = 'jobs-panel-current';
                    currentTag.textContent = '● selected';
                    actions.appendChild(currentTag);
                } else {
                    const switchBtn = document.createElement('button');
                    switchBtn.type = 'button';
                    switchBtn.textContent = 'Switch';
                    switchBtn.addEventListener('click', () => switchToJob(job.id));
                    actions.appendChild(switchBtn);
                }

                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'jobs-panel-delete';
                deleteBtn.textContent = 'Delete';
                deleteBtn.addEventListener('click', () => deleteJob(job));
                actions.appendChild(deleteBtn);

                row.appendChild(actions);
                panel.appendChild(row);
            });

            const addLink = document.createElement('a');
            addLink.href = 'userinfo.html';
            addLink.className = 'jobs-panel-add';
            addLink.textContent = '+ Add another job';
            panel.appendChild(addLink);
        }

        // reloads everything on the page that depends on which job is selected
        async function reloadJobData()
        {
            await loadTodaysCommissions();
            await loadCommissionEntriesForDate(document.getElementById('commission-date').value || todayStr());
            await loadTodaysBreaks();
            await refreshTotals();
            await renderMonthlyChart();
            await loadMonthCompare();
            await loadYearTotals();
            await loadSaveGoalPlanner();
        }

        // switches the whole page to a different job
        async function switchToJob(jobId)
        {
            // a shift that is running belongs to one company, so the user has to clock out before switching
            if (activeShift) {
                return alert('Please clock out before switching jobs.');
            }

            userJob = userJobs.find(j => String(j.id) === String(jobId));
            selectedJobId = userJob.id;
            showJobInHeader();
            await reloadJobData();
        }

        // deletes a job after asking. the database also removes everything logged under that job
        async function deleteJob(job)
        {
            // the running shift belongs to this job, so it has to be clocked out first
            if (activeShift && activeShift.job_id === job.id) {
                return alert('Please clock out before deleting this job.');
            }

            const confirmed = confirm('Delete "' + jobLabel(job) + '"?\n\nThis also deletes every shift, lunch break and commission logged under this job, and it changes your totals. This cannot be undone.');
            if (!confirmed) return;

            const { error } = await supabaseClient
                .from('jobs')
                .delete()
                .eq('id', job.id)
                .eq('user_id', currentUser.userId);

            if (error) {
                return alert('Error deleting the job: ' + error.message);
            }

            userJobs = userJobs.filter(j => j.id !== job.id);

            // if the deleted job was the selected one, we move to the next job in the list (if there is one)
            if (userJob && userJob.id === job.id) {
                userJob = userJobs[0] || null;
                selectedJobId = userJob ? userJob.id : null;
            }

            showJobInHeader();

            if (userJobs.length === 0) {
                const jobsPanel = document.getElementById('jobs-panel');
                if (jobsPanel) jobsPanel.style.display = 'none';
                alert('You have no jobs left. Add one on the My Jobs page to keep tracking your pay.');
            }

            await reloadJobData();
        }

        // fetches today's commission entries and sums them per job_id
        async function loadTodaysCommissions() {
            const { data, error } = await supabaseClient
                .from('commissions')
                .select('job_id, amount')
                .eq('user_id', currentUser.userId)
                .eq('entry_date', todayStr());

            todaysCommissionByJob = {};
            if (!error && data) {
                data.forEach(c => {
                    const key = String(c.job_id);
                    todaysCommissionByJob[key] = (todaysCommissionByJob[key] || 0) + parseFloat(c.amount);
                });
            }
        }

        // NOTE: getWeekStartDate now lives in shared.js

        // sums completed hours worked this week at the same COMPANY as the given job, up to (not including) a cutoff time —
        // used as the "baseline" so the live counter knows if it's already past the overtime threshold.
        // hours at a different company are not counted, because overtime is per company
        async function getWeeklyHoursBeforeShift(job, cutoffDate) {
            const weekStart = getWeekStartDate(cutoffDate);

            const { data, error } = await supabaseClient
                .from('shifts')
                .select('id, job_id, clock_in, clock_out, jobs(company)')
                .eq('user_id', currentUser.userId)
                .not('clock_out', 'is', null)
                .gte('clock_in', weekStart.toISOString())
                .lt('clock_in', cutoffDate.toISOString());

            if (error || !data) return 0;

            // keep only the shifts that belong to the same company as this job
            const employerKey = getEmployerKey(job.company, job.id);
            const sameCompanyShifts = data.filter(s => getEmployerKey(s.jobs && s.jobs.company, s.job_id) === employerKey);

            // take the lunch breaks out the same way the totals do, so the live counter and the totals agree
            const breaksByShiftId = await fetchBreaksByShiftId(sameCompanyShifts.map(s => s.id));

            return sameCompanyShifts.reduce((sum, s) => {
                const rawHours = (new Date(s.clock_out) - new Date(s.clock_in)) / (1000 * 60 * 60);
                const breakHours = (breaksByShiftId.get(s.id) || []).reduce((breakSum, b) => {
                    if (!b.break_end) return breakSum; // a break that was never closed does not count
                    return breakSum + (new Date(b.break_end) - new Date(b.break_start)) / (1000 * 60 * 60);
                }, 0);
                return sum + Math.max(0, rawHours - breakHours);
            }, 0);
        }

        // ---------- CLOCK IN / OUT ----------
        async function checkActiveShift() {
            const { data, error } = await supabaseClient
                .from('shifts')
                .select('*')
                .eq('user_id', currentUser.userId)
                .is('clock_out', null)
                .order('clock_in', { ascending: false })
                .limit(1);

            if (!error && data && data.length > 0) {
                activeShift = data[0];
                selectedJobId = activeShift.job_id;

                // if the running shift belongs to a different job than the one showing, switch to that job
                const activeJob = userJobs.find(j => j.id === activeShift.job_id);
                if (activeJob) {
                    userJob = activeJob;
                    showJobInHeader();
                }
                document.getElementById('clock-in').disabled = true;
                document.getElementById('clock-out').disabled = false;
                document.getElementById('start-lunch-btn').disabled = false;
                document.getElementById('clock-status').textContent = 'Clocked in since ' + new Date(activeShift.clock_in).toLocaleTimeString();
                document.getElementById('clock-status').classList.add('active');

                // also check if there's an already-open lunch break for this shift
                // (in case the page was refreshed mid-break)
                await checkActiveBreak();
                await startLiveTimer();
            }
        }

        // checks whether the current active shift already has an open (unfinished) break
        async function checkActiveBreak() {
            if (!activeShift) return;

            const { data, error } = await supabaseClient
                .from('breaks')
                .select('*')
                .eq('shift_id', activeShift.id)
                .is('break_end', null)
                .order('break_start', { ascending: false })
                .limit(1);

            if (!error && data && data.length > 0) {
                activeBreak = data[0];
                setLunchButtonsState(true);
                document.getElementById('lunch-status').textContent = 'On lunch since ' + new Date(activeBreak.break_start).toLocaleTimeString();
            }
        }

        // toggles which of the two lunch buttons is visible/enabled
        function setLunchButtonsState(onBreak) {
            document.getElementById('start-lunch-btn').style.display = onBreak ? 'none' : 'inline-block';
            document.getElementById('end-lunch-btn').style.display = onBreak ? 'inline-block' : 'none';
            document.getElementById('end-lunch-btn').disabled = !onBreak;
        }

        document.getElementById('clock-in').addEventListener('click', async () => {
            const clockInBtn = document.getElementById('clock-in');

            if (!selectedJobId) {
                alert('Please add a job in User Info before clocking in.');
                return;
            }

            // ---- duplicate clock-in safeguard ----
            // Disable the button IMMEDIATELY, before any network request. If we
            // waited until after the insert to disable it, a fast double-click
            // could fire two inserts before the first one's response comes back,
            // creating two open shifts at once.
            clockInBtn.disabled = true;

            // Extra server-side check as a safety net: even with the button
            // disabled, ask the database directly whether an open shift already
            // exists for this user, in case of a stale page state or a second
            // browser tab.
            const { data: existingOpenShifts } = await supabaseClient
                .from('shifts')
                .select('id')
                .eq('user_id', currentUser.userId)
                .is('clock_out', null)
                .limit(1);

            if (existingOpenShifts && existingOpenShifts.length > 0) {
                alert('You already have an open shift. Please clock out of it first.');
                clockInBtn.disabled = false;
                return;
            }

            const clockInTime = new Date().toISOString();
            const { data, error } = await supabaseClient
                .from('shifts')
                .insert([{ user_id: currentUser.userId, job_id: selectedJobId, clock_in: clockInTime }])
                .select();

            if (error) {
                alert('Error clocking in: ' + error.message);
                clockInBtn.disabled = false; // re-enable so they can try again
                return;
            }

            activeShift = data[0];
            document.getElementById('clock-out').disabled = false;
            document.getElementById('start-lunch-btn').disabled = false;
            document.getElementById('clock-status').textContent = 'Clocked in since ' + new Date(activeShift.clock_in).toLocaleTimeString();
            document.getElementById('clock-status').classList.add('active');
            await startLiveTimer();
        });

        document.getElementById('clock-out').addEventListener('click', async () => {
            if (!activeShift) return;
            const clockOutBtn = document.getElementById('clock-out');
            clockOutBtn.disabled = true; // guard against double-click here too

            // if they're still on lunch, automatically close out the break first
            // so it doesn't get left open forever
            if (activeBreak) {
                await endLunch(false); // false = don't refresh totals yet, clock-out below will
            }

            const clockOutTime = new Date().toISOString();

            const { error } = await supabaseClient
                .from('shifts')
                .update({ clock_out: clockOutTime })
                .eq('id', activeShift.id);

            if (error) {
                alert('Error clocking out: ' + error.message);
                clockOutBtn.disabled = false;
                return;
            }

            clearInterval(liveTimerInterval);
            activeShift = null;
            liveShiftWage = 0;
            document.getElementById('clock-in').disabled = false;
            document.getElementById('clock-out').disabled = true;
            document.getElementById('start-lunch-btn').disabled = true;
            setLunchButtonsState(false);
            document.getElementById('lunch-status').textContent = '';
            document.getElementById('clock-status').textContent = 'Not clocked in';
            document.getElementById('clock-status').classList.remove('active');
            await refreshTotals(); // this now also sets the earnings box to today's total on its own
        });

        // ---------- LUNCH BREAK ----------
        document.getElementById('start-lunch-btn').addEventListener('click', async () => {
            if (!activeShift || activeBreak) return;
            const btn = document.getElementById('start-lunch-btn');
            btn.disabled = true; // guard against double-click

            const { data, error } = await supabaseClient
                .from('breaks')
                .insert([{
                    user_id: currentUser.userId,
                    shift_id: activeShift.id,
                    break_start: new Date().toISOString()
                }])
                .select();

            if (error) {
                alert('Error starting lunch: ' + error.message);
                btn.disabled = false;
                return;
            }

            // the break was saved. Normally the database sends the new row back right away. If it did not
            // (for example a permission rule that blocks reading it), we look the open break up again,
            // so the End Lunch button still shows up instead of the page getting stuck on lunch
            activeBreak = (data && data[0]) ? data[0] : null;
            if (!activeBreak) await checkActiveBreak();

            if (!activeBreak) {
                alert('Lunch was started, but the page could not read it back. Refresh the page to see the End Lunch button.');
                btn.disabled = false;
                return;
            }

            setLunchButtonsState(true);
            document.getElementById('lunch-status').textContent = 'On lunch since ' + new Date(activeBreak.break_start).toLocaleTimeString();
            await loadTodaysBreaks();
        });

        document.getElementById('end-lunch-btn').addEventListener('click', () => endLunch(true));

        // shared function so clock-out can also close an open lunch automatically
        async function endLunch(shouldRefresh) {
            if (!activeBreak) return;
            const btn = document.getElementById('end-lunch-btn');
            btn.disabled = true;

            const { error } = await supabaseClient
                .from('breaks')
                .update({ break_end: new Date().toISOString() })
                .eq('id', activeBreak.id);

            if (error) {
                alert('Error ending lunch: ' + error.message);
                btn.disabled = false;
                return;
            }

            activeBreak = null;
            setLunchButtonsState(false);
            document.getElementById('lunch-status').textContent = '';
            await loadTodaysBreaks();
            if (shouldRefresh) await refreshTotals();
        }

        // ============================================================
        // TODAY'S LUNCH BREAKS — list, edit, delete
        // ============================================================

        // Fetches every break logged against a shift that started today,
        // for the current user, and renders them as editable rows.
        async function loadTodaysBreaks() {
            const container = document.getElementById('lunch-breaks-list');
            const todayStart = parseLocalDate(todayStr());
            const tomorrow = new Date(todayStart);
            tomorrow.setDate(tomorrow.getDate() + 1);

            // find today's shifts first, then find breaks attached to them
            const { data: todaysShifts, error: shiftsError } = await supabaseClient
                .from('shifts')
                .select('id')
                .eq('user_id', currentUser.userId)
                .gte('clock_in', todayStart.toISOString())
                .lt('clock_in', tomorrow.toISOString());

            if (shiftsError || !todaysShifts || todaysShifts.length === 0) {
                container.textContent = 'No breaks logged today.';
                return;
            }

            const shiftIds = todaysShifts.map(s => s.id);
            const { data: breaks, error: breaksError } = await supabaseClient
                .from('breaks')
                .select('id, shift_id, break_start, break_end')
                .in('shift_id', shiftIds)
                .order('break_start', { ascending: true });

            if (breaksError || !breaks || breaks.length === 0) {
                container.textContent = 'No breaks logged today.';
                return;
            }

            container.innerHTML = '';
            breaks.forEach(b => {
                container.appendChild(buildBreakRow(b));
            });
        }

        function buildBreakRow(breakEntry) {
            const row = document.createElement('div');
            row.className = 'break-row';
            row.id = 'break-row-' + breakEntry.id;
            renderBreakViewMode(row, breakEntry);
            return row;
        }

        // reuses the same "YYYY-MM-DDTHH:mm" conversion pattern as shifts.js,
        // so datetime-local inputs show the correct local time
        function toDatetimeLocalValue(isoString) {
            if (!isoString) return '';
            const d = new Date(isoString);
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }

        function renderBreakViewMode(row, breakEntry) {
            const startDisplay = new Date(breakEntry.break_start).toLocaleTimeString();
            const endDisplay = breakEntry.break_end
                ? new Date(breakEntry.break_end).toLocaleTimeString()
                : 'Still on break';

            row.innerHTML = `
                <span class="break-time">${startDisplay} – ${endDisplay}</span>
                <span class="break-actions">
                    <button type="button" class="edit-break-btn">Edit</button>
                    <button type="button" class="delete-break-btn">Delete</button>
                </span>
            `;
            row.querySelector('.edit-break-btn').addEventListener('click', () => renderBreakEditMode(row, breakEntry));
            row.querySelector('.delete-break-btn').addEventListener('click', () => deleteBreakEntry(breakEntry.id));
        }

        function renderBreakEditMode(row, breakEntry) {
            row.innerHTML = `
                <span class="break-edit-fields">
                    <label>Start: <input type="datetime-local" class="edit-break-start" value="${toDatetimeLocalValue(breakEntry.break_start)}"></label>
                    <label>End: <input type="datetime-local" class="edit-break-end" value="${toDatetimeLocalValue(breakEntry.break_end)}"></label>
                </span>
                <span class="break-actions">
                    <button type="button" class="save-break-btn">Save</button>
                    <button type="button" class="cancel-break-btn">Cancel</button>
                </span>
                <p class="break-edit-status form-status"></p>
            `;
            row.querySelector('.save-break-btn').addEventListener('click', () => saveBreakEdit(row, breakEntry));
            row.querySelector('.cancel-break-btn').addEventListener('click', () => renderBreakViewMode(row, breakEntry));
        }

        async function saveBreakEdit(row, breakEntry) {
            const statusEl = row.querySelector('.break-edit-status');
            const startValue = row.querySelector('.edit-break-start').value;
            const endValue = row.querySelector('.edit-break-end').value;

            const startDate = startValue ? new Date(startValue) : null;
            const endDate = endValue ? new Date(endValue) : null;

            switch (true) {
                case !startDate:
                    statusEl.textContent = 'Start time is required.';
                    return;
                case endDate && endDate <= startDate:
                    statusEl.textContent = 'End time must be after start time.';
                    return;
            }

            const { error } = await supabaseClient
                .from('breaks')
                .update({
                    break_start: startDate.toISOString(),
                    break_end: endDate ? endDate.toISOString() : null
                })
                .eq('id', breakEntry.id);

            if (error) {
                statusEl.textContent = 'Error: ' + error.message;
                return;
            }

            await loadTodaysBreaks();
            await refreshTotals(); // break time affects pay, so totals need recalculating
        }

        async function deleteBreakEntry(breakId) {
            const confirmed = confirm('Delete this lunch break entry?');
            if (!confirmed) return;

            const { error } = await supabaseClient.from('breaks').delete().eq('id', breakId);

            if (error) {
                alert('Error deleting break: ' + error.message);
                return;
            }

            await loadTodaysBreaks();
            await refreshTotals();
        }

        // sums completed break minutes for a shift, plus any currently-ongoing
        // break, so the live pay counter can exclude unpaid lunch time
        function getBreakMsSoFar(breaksForShift) {
            const now = new Date();
            return breaksForShift.reduce((totalMs, b) => {
                const start = new Date(b.break_start);
                const end = b.break_end ? new Date(b.break_end) : now; // still-open break counts up to now
                return totalMs + (end - start);
            }, 0);
        }

        // checks the database for the running shift, because it can be changed somewhere else
        // (the Shifts page, another tab, another device). it handles three cases:
        // - the shift was deleted or clocked out: we stop the live counter
        // - the clock-in time was edited: we use the new time and recalculate
        // - nothing changed: we do nothing
        async function syncActiveShiftWithDatabase() {
            if (!activeShift) return;

            const { data, error } = await supabaseClient
                .from('shifts')
                .select('*')
                .eq('id', activeShift.id)
                .maybeSingle();

            if (error) return; // can't reach the database right now, so keep what we have

            if (!data || data.clock_out) {
                clearInterval(liveTimerInterval);
                activeShift = null;
                activeBreak = null;
                liveShiftWage = 0;
                document.getElementById('clock-in').disabled = false;
                document.getElementById('clock-out').disabled = true;
                document.getElementById('start-lunch-btn').disabled = true;
                setLunchButtonsState(false);
                document.getElementById('lunch-status').textContent = '';
                document.getElementById('clock-status').textContent = 'Not clocked in';
                document.getElementById('clock-status').classList.remove('active');
                await refreshTotals();
                return;
            }

            if (new Date(data.clock_in).getTime() !== new Date(activeShift.clock_in).getTime()) {
                activeShift = data;
                const job = getSelectedJob();
                minutesBeforeThisShift = job
                    ? (await getWeeklyHoursBeforeShift(job, new Date(data.clock_in))) * 60
                    : 0;
                document.getElementById('clock-status').textContent = 'Clocked in since ' + new Date(data.clock_in).toLocaleTimeString();
                await refreshTotals();
            }
        }

        // when the user comes back to this tab (for example after editing the shift on the Shifts page) we check right away
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                syncActiveShiftWithDatabase();
            }
        });

        async function startLiveTimer() {
            const job = getSelectedJob();
            const wage = job ? parseFloat(job.hourly_wage) : 0;
            const minuteWage = wage / 60; // pay rate per minute, the basis for the live tracker

            // minutes already worked this week (other completed shifts, same company) before this one started
            minutesBeforeThisShift = job
                ? (await getWeeklyHoursBeforeShift(job, new Date(activeShift.clock_in))) * 60
                : 0;

            let tickCount = 0;
            liveTimerInterval = setInterval(async () => {
                // every 15 seconds we ask the database if this shift was changed on another page
                // (for example the clock-in time edited on the Shifts page) and pick up the change
                tickCount++;
                if (tickCount % 15 === 0) {
                    await syncActiveShiftWithDatabase();
                }
                if (!activeShift) return; // the sync found the shift was clocked out or deleted

                const now = new Date();
                const clockInTime = new Date(activeShift.clock_in);

                // fetch this shift's breaks fresh each tick — cheap query, and
                // keeps the live counter accurate the instant lunch starts/ends
                const { data: breaksForShift } = await supabaseClient
                    .from('breaks')
                    .select('break_start, break_end')
                    .eq('shift_id', activeShift.id);

                const breakMs = getBreakMsSoFar(breaksForShift || []);
                const rawElapsedMinutes = (now - clockInTime) / (1000 * 60);
                const elapsedMinutes = Math.max(0, rawElapsedMinutes - (breakMs / (1000 * 60))); // lunch time doesn't count toward pay

                // a clock-in time that is still in the future can't earn anything yet, so we say why the counter is at $0.00
                if (rawElapsedMinutes < 0) {
                    document.getElementById('clock-status').textContent = 'Clock-in time is in the future. Fix it on the Shifts page.';
                }

                // live tracker = minute wage × minutes worked, with the overtime
                // bump applied to whichever minutes push the week past 40 hours
                // (2400 minutes) for this job
                const OVERTIME_WEEKLY_THRESHOLD_MINUTES = OVERTIME_WEEKLY_THRESHOLD * 60;
                const regularMinutes = Math.max(0, Math.min(elapsedMinutes, OVERTIME_WEEKLY_THRESHOLD_MINUTES - minutesBeforeThisShift));
                const overtimeMinutes = elapsedMinutes - regularMinutes;
                const wagePay = (regularMinutes * minuteWage) + (overtimeMinutes * minuteWage * OVERTIME_MULTIPLIER);

                liveShiftWage = wagePay; // lets the Day / Week / Month / Year totals follow the running shift
                renderTotals();

                // live tracker = everything already earned today at every job (finished shifts + all commission)
                // + what the running shift has earned so far
                const earnedBeforeWage = todayBase ? todayBase.wage : 0;
                const earnedBeforeCommission = todayBase ? todayBase.commission : 0;
                const pay = earnedBeforeWage + wagePay + earnedBeforeCommission;

                // the small line under the big number follows along too
                const breakdownLine = document.getElementById('day-breakdown');
                if (todayBase && breakdownLine) {
                    breakdownLine.textContent = `Wages: ${formatMoney(earnedBeforeWage + wagePay)} • Commission: ${formatMoney(earnedBeforeCommission)}`;
                }

                const payDisplay = document.getElementById('live-pay');
                // if the user chose "Show After Tax" we keep (100 - tax%) of the pay, otherwise we keep all of it
                const keepShare = showAfterTax['constantpay'] ? 1 - taxRate / 100 : 1;
                payDisplay.textContent = formatMoney(pay * keepShare);
                payDisplay.classList.remove('tick');
                void payDisplay.offsetWidth; // restart animation
                payDisplay.classList.add('tick');
            }, 1000);
        }

        // ---------- COMMISSION ----------
        document.getElementById('add-commission-btn').addEventListener('click', async () => {
            const input = document.getElementById('commission-input');
            const dateInput = document.getElementById('commission-date');
            const amount = parseFloat(input.value);
            const entryDate = dateInput.value || todayStr();
            const statusEl = document.getElementById('commission-status');
            const MAX_REASONABLE_COMMISSION = 100000;

            switch (true) {
                case !selectedJobId:
                    statusEl.textContent = 'Add a job in User Info before logging commission.';
                    statusEl.style.color = '#dc2626';
                    return;
                case isNaN(amount) || amount <= 0:
                    statusEl.textContent = 'Enter a valid commission amount.';
                    statusEl.style.color = '#dc2626';
                    return;
                case amount > MAX_REASONABLE_COMMISSION:
                    statusEl.textContent = `That amount seems too high — please double-check it.`;
                    statusEl.style.color = '#dc2626';
                    return;
            }

            const { error } = await supabaseClient
                .from('commissions')
                .insert([{
                    user_id: currentUser.userId,
                    job_id: selectedJobId,
                    amount: amount,
                    entry_date: entryDate
                }]);

            if (error) {
                statusEl.textContent = 'Error: ' + error.message;
                statusEl.style.color = '#dc2626';
                return;
            }

            statusEl.textContent = 'Commission added!';
            statusEl.style.color = '#0f766e';
            input.value = '';
            await loadTodaysCommissions();
            await loadCommissionEntriesForDate(entryDate);
            await refreshTotals();
        });

        // reloads the commission entries list whenever the commission date field changes
        document.getElementById('commission-date').addEventListener('change', () => {
            loadCommissionEntriesForDate(document.getElementById('commission-date').value || todayStr());
        });

        // Fetches and renders every commission entry logged for a given date,
        // with inline Edit and Delete controls on each row.
        async function loadCommissionEntriesForDate(dateStr) {
            const container = document.getElementById('commission-entries-list');
            const { data, error } = await supabaseClient
                .from('commissions')
                .select('id, amount, job_id, jobs(job_title, company)')
                .eq('user_id', currentUser.userId)
                .eq('entry_date', dateStr)
                .order('id', { ascending: true });

            if (error) {
                container.textContent = 'Could not load commission entries.';
                return;
            }

            if (!data || data.length === 0) {
                container.textContent = 'No commission logged for this date.';
                return;
            }

            container.innerHTML = '';
            data.forEach(entry => {
                container.appendChild(buildCommissionRow(entry));
            });
        }

        function buildCommissionRow(entry) {
            const row = document.createElement('div');
            row.className = 'commission-row';
            row.id = 'commission-row-' + entry.id;
            renderCommissionViewMode(row, entry);
            return row;
        }

        function renderCommissionViewMode(row, entry) {
            const jobTitle = entry.jobs ? jobLabel(entry.jobs) : '(job removed)';
            row.innerHTML = `
                <span class="commission-job">${jobTitle}</span>
                <span class="commission-amount">${formatMoney(parseFloat(entry.amount))}</span>
                <span class="commission-actions">
                    <button type="button" class="edit-commission-btn">Edit</button>
                    <button type="button" class="delete-commission-btn">Delete</button>
                </span>
            `;
            row.querySelector('.edit-commission-btn').addEventListener('click', () => renderCommissionEditMode(row, entry));
            row.querySelector('.delete-commission-btn').addEventListener('click', () => deleteCommissionEntry(entry.id));
        }

        function renderCommissionEditMode(row, entry) {
            const jobTitle = entry.jobs ? jobLabel(entry.jobs) : '(job removed)';
            row.innerHTML = `
                <span class="commission-job">${jobTitle}</span>
                <input type="number" class="edit-commission-amount" step="0.01" min="0.01" value="${entry.amount}">
                <span class="commission-actions">
                    <button type="button" class="save-commission-btn">Save</button>
                    <button type="button" class="cancel-commission-btn">Cancel</button>
                </span>
            `;
            row.querySelector('.save-commission-btn').addEventListener('click', () => saveCommissionEdit(row, entry));
            row.querySelector('.cancel-commission-btn').addEventListener('click', () => renderCommissionViewMode(row, entry));
        }

        async function saveCommissionEdit(row, entry) {
            const newAmount = parseFloat(row.querySelector('.edit-commission-amount').value);

            if (isNaN(newAmount) || newAmount <= 0) {
                alert('Please enter a valid amount.');
                return;
            }

            const { error } = await supabaseClient
                .from('commissions')
                .update({ amount: newAmount })
                .eq('id', entry.id);

            if (error) {
                alert('Error updating commission: ' + error.message);
                return;
            }

            entry.amount = newAmount;
            renderCommissionViewMode(row, entry);
            await loadTodaysCommissions();
            await refreshTotals();
        }

        async function deleteCommissionEntry(entryId) {
            const confirmed = confirm('Delete this commission entry?');
            if (!confirmed) return;

            const { error } = await supabaseClient.from('commissions').delete().eq('id', entryId);

            if (error) {
                alert('Error deleting commission: ' + error.message);
                return;
            }

            await loadCommissionEntriesForDate(document.getElementById('commission-date').value || todayStr());
            await loadTodaysCommissions();
            await refreshTotals();
        }

        // ---------- TOTALS ----------
        function getRangeStart(period, refDate) {
            const d = new Date(refDate);
            if (period === 'day') {
                return new Date(d.getFullYear(), d.getMonth(), d.getDate());
            }
            if (period === 'week') {
                const day = d.getDay();
                const diff = d.getDate() - day; // start on Sunday
                return new Date(d.getFullYear(), d.getMonth(), diff);
            }
            if (period === 'month') {
                return new Date(d.getFullYear(), d.getMonth(), 1);
            }
            if (period === 'year') {
                return new Date(d.getFullYear(), 0, 1);
            }
        }

        // the first moment AFTER a period ends (the end itself is not part of the period)
        function getRangeEnd(period, start) {
            if (period === 'day') {
                return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
            }
            if (period === 'week') {
                return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
            }
            if (period === 'month') {
                return new Date(start.getFullYear(), start.getMonth() + 1, 1);
            }
            if (period === 'year') {
                return new Date(start.getFullYear() + 1, 0, 1);
            }
        }

        // midnight at the START of tomorrow. the end of a range is not included, so using this
        // as the end makes sure everything from today counts (including today's commission)
        function getTomorrowStart() {
            const tomorrow = parseLocalDate(todayStr());
            tomorrow.setDate(tomorrow.getDate() + 1);
            return tomorrow;
        }

        async function computeShiftsPay(startDate, endDate) {
            // fetch from the start of the week containing startDate, so weekly overtime
            // accumulation is calculated correctly even if the period starts mid-week
            const fetchFrom = getWeekStartDate(startDate);

            const { data: shifts, error } = await supabaseClient
                .from('shifts')
                .select('*, jobs(hourly_wage, company)')
                .eq('user_id', currentUser.userId)
                .not('clock_out', 'is', null)
                .gte('clock_in', fetchFrom.toISOString())
                .lt('clock_in', endDate.toISOString());

            if (error || !shifts) {
                // before this, a failed load quietly showed $0.00 everywhere. now the user is told why, once
                console.error('Could not load shifts:', error);
                if (!shiftsErrorShown) {
                    shiftsErrorShown = true;
                    alert('Could not load your shifts: ' + (error ? error.message : 'unknown error') + '\n\nIf this mentions "company", run jobs-add-company.sql in Supabase first.');
                }
                return 0;
            }

            const breaksByShiftId = await fetchBreaksByShiftId(shifts.map(s => s.id));
            const shiftPayMap = computeShiftPayWithOvertime(shifts, breaksByShiftId);

            let total = 0;
            shifts.forEach(s => {
                const clockIn = new Date(s.clock_in);
                if (clockIn >= startDate && clockIn < endDate) {
                    total += shiftPayMap.get(s) || 0;
                }
            });
            return total;
        }

        async function computeCommissions(startDate, endDate) {
            const { data: commissions, error } = await supabaseClient
                .from('commissions')
                .select('amount, entry_date')
                .eq('user_id', currentUser.userId)
                .gte('entry_date', startDate.toISOString().split('T')[0])
                .lt('entry_date', endDate.toISOString().split('T')[0]);

            if (error || !commissions) return 0;
            return commissions.reduce((sum, c) => sum + parseFloat(c.amount), 0);
        }

        async function refreshTotals() {
            const refDate = parseLocalDate(document.getElementById('view-date').value || todayStr());

            let dayWagePay = 0;
            let dayCommissionPay = 0;

            const periods = ['day', 'week', 'month', 'year'];
            for (const period of periods) {
                const start = getRangeStart(period, refDate);
                const end = getRangeEnd(period, start); // day = next midnight, week = +7 days, month/year = next month/year

                const shiftsPay = await computeShiftsPay(start, end);
                const commissionPay = await computeCommissions(start, end);
                // remember the before-tax total, so the live timer can add the running shift on top of it
                totalsBase[period] = shiftsPay + commissionPay;
                totalsRanges[period] = { start: start, end: end };

                if (period === 'day') {
                    dayWagePay = shiftsPay;
                    dayCommissionPay = commissionPay;
                }
            }

            // remember today's finished wage and commission from ALL jobs, so the live counter can add the running shift on top.
            // this is what makes a day with two companies add up as one day
            todayBase = (document.getElementById('view-date').value || todayStr()) === todayStr()
                ? { wage: dayWagePay, commission: dayCommissionPay }
                : null;

            renderTotals();

            // both the big number AND the breakdown line follow whichever date
            // is selected in the "Viewing:" picker — if that date is today AND
            // there's an active shift, the live timer keeps controlling the
            // number instead (handled inside this function)
            updateEarningsBox(refDate, dayWagePay, dayCommissionPay);

            // the Daily Summary shows the same date as the "Viewing:" picker (today to start).
            // clock out, commission and break changes all come through here, so it stays up to date
            await loadDailySummaryForDate(document.getElementById('view-date').value || todayStr());

            loadRecentDays().catch(error => console.warn('last 7 days failed:', error.message));
        }

        // first it will take the saved totals for each period, then if a shift is running
        // right now it will add what that shift has earned so far to every period it falls
        // inside, and finally it will apply the tax toggle and show the numbers.
        // the live timer calls this every second, so the totals move while you work
        function renderTotals() {
            const periods = ['day', 'week', 'month', 'year'];
            periods.forEach(period => {
                if (totalsBase[period] === undefined) return;

                let total = totalsBase[period];

                if (activeShift) {
                    const clockIn = new Date(activeShift.clock_in);
                    const range = totalsRanges[period];
                    if (clockIn >= range.start && clockIn < range.end) {
                        total += liveShiftWage;
                    }
                }

                const keepShare = showAfterTax['pay-section'] ? 1 - taxRate / 100 : 1; // the share left after the tax % the user typed
                document.getElementById('total-' + period).textContent = formatMoney(total * keepShare);
            });

            renderDailySummary(); // the live timer calls this every second, so the summary moves too
        }

        // On TODAY: shows the big live counter (ticking in real time if clocked
        // in), with a small wage/commission breakdown underneath.
        // On any OTHER selected date: hides the big counter entirely and shows
        // the wage/commission breakdown as the main display instead — no single
        // combined number, just the two parts shown separately.
        function updateEarningsBox(refDate, wagePay, commissionPay) {
            const today = new Date();
            const isToday = refDate.getFullYear() === today.getFullYear()
                && refDate.getMonth() === today.getMonth()
                && refDate.getDate() === today.getDate();

            const labelEl = document.getElementById('earnings-label');
            const bigNumberEl = document.getElementById('live-pay');
            const breakdownEl = document.getElementById('day-breakdown');

            if (isToday) {
                bigNumberEl.style.display = '';
                breakdownEl.classList.remove('breakdown-primary');
                breakdownEl.textContent = `Wages: ${formatMoney(wagePay)} • Commission: ${formatMoney(commissionPay)}`;
                labelEl.textContent = "Today's Earnings";

                if (activeShift) {
                    return; // live timer owns the big number itself, don't overwrite it
                }

                const keepShare = showAfterTax['constantpay'] ? 1 - taxRate / 100 : 1;
                const total = (wagePay + commissionPay) * keepShare;
                bigNumberEl.textContent = formatMoney(total);
            } else {
                // not today — hide the single combined number, show wage/commission
                // as two separate figures instead
                bigNumberEl.style.display = 'none';
                breakdownEl.classList.add('breakdown-primary');
                const keepShare = showAfterTax['constantpay'] ? 1 - taxRate / 100 : 1;
                breakdownEl.innerHTML = `<span>Wages: ${formatMoney(wagePay * keepShare)}</span><span>Commission: ${formatMoney(commissionPay * keepShare)}</span>`;
                labelEl.textContent = `Earnings for ${refDate.toLocaleDateString()}`;
            }
        }

        document.getElementById('view-date').addEventListener('change', refreshTotals);
        document.getElementById('view-date-btn').addEventListener('click', async () => {
            const btn = document.getElementById('view-date-btn');
            const originalText = btn.textContent;
            btn.textContent = 'Loading...';
            btn.disabled = true;
            await refreshTotals();
            btn.textContent = originalText;
            btn.disabled = false;
        });

        // ---------- TAX RATE BOX ----------
        // whenever the tax rate changes we update every number that can show after tax
        addListener('tax-rate', 'input', () => {
            const typedRate = parseFloat(document.getElementById('tax-rate').value);

            switch (true) {
                case isNaN(typedRate) || typedRate < 0:
                    taxRate = 0; // empty or negative box means no tax taken out
                    break;
                case typedRate > 100:
                    taxRate = 100; // can't take out more than everything
                    break;
                default:
                    taxRate = typedRate;
            }

            try { localStorage.setItem('taxRate', String(taxRate)); } catch (e) { /* private window, just don't remember it */ }

            refreshTotals();
            renderMonthlyChart();
            renderRecentDays();
            if (scheduleWeekStart) renderScheduleSummary(); // the schedule estimate also shows after tax
        });

        // puts the tax rate the user typed last time back into the box
        function applySavedTaxRate()
        {
            try {
                const saved = parseFloat(localStorage.getItem('taxRate'));
                if (!isNaN(saved) && saved >= 0 && saved <= 100) {
                    taxRate = saved;
                    document.getElementById('tax-rate').value = saved;
                }
            } catch (e) { /* nothing saved, keep the 5% default */ }
        }
        applySavedTaxRate();

        // ---------- COLLAPSIBLE SECTIONS ----------
        // each <details data-key="..."> remembers if it was left open or closed
        function initCollapsibles()
        {
            document.querySelectorAll('details[data-key]').forEach(box => {
                try {
                    const saved = localStorage.getItem('open-' + box.dataset.key);
                    if (saved === 'yes') box.open = true;
                    if (saved === 'no') box.open = false;
                } catch (e) { /* keep the default */ }

                box.addEventListener('toggle', () => {
                    try { localStorage.setItem('open-' + box.dataset.key, box.open ? 'yes' : 'no'); } catch (e) { /* ignore */ }
                });
            });
        }
        initCollapsibles();

        // ---------- STICKY BAR POSITION ----------
        // the jump bar sticks right under the top menu, so it needs to know how tall that menu is
        function setNavHeight()
        {
            const nav = document.querySelector('.main-nav');
            if (nav) document.documentElement.style.setProperty('--nav-h', nav.offsetHeight + 'px');
        }
        setNavHeight();
        window.addEventListener('resize', setNavHeight);

        // ---------- TAX TOGGLE ----------
        // one button for the whole page. first it flips every "after tax" switch together,
        // then it changes its own text, then it redraws the totals and the chart
        addListener('tax-toggle-all', 'click', () => {
            const turnOn = !showAfterTax['pay-section'];
            Object.keys(showAfterTax).forEach(key => {
                showAfterTax[key] = turnOn;
            });

            const btn = document.getElementById('tax-toggle-all');
            btn.textContent = turnOn ? 'Showing after tax' : 'Showing before tax';
            btn.classList.toggle('on', turnOn);

            refreshTotals();
            renderMonthlyChart();
            renderRecentDays();
        });

        // ---------- EDIT JOB (company + title) ----------
        // the "Edit" button next to the job name opens a small form to change the company and the job title.
        // the hourly wage is changed on the Profile page
        addListener('edit-job-btn', 'click', () => {
            document.getElementById('edit-job-company-input').value = userJob ? (userJob.company || '') : '';
            document.getElementById('edit-job-title-input').value = userJob ? userJob.job_title : '';
            document.getElementById('edit-job-form').style.display = 'flex';
            document.getElementById('edit-job-status').textContent = '';
        });

        addListener('cancel-job-title-btn', 'click', () => {
            document.getElementById('edit-job-form').style.display = 'none';
        });

        addListener('save-job-title-btn', 'click', async () => {
            const newCompany = document.getElementById('edit-job-company-input').value.trim();
            const newTitle = document.getElementById('edit-job-title-input').value.trim();
            const statusEl = document.getElementById('edit-job-status');

            switch (true) {
                case !userJob:
                    statusEl.textContent = 'Add a job in My Jobs first.';
                    statusEl.style.color = '#dc2626';
                    return;
                case !newCompany:
                    statusEl.textContent = 'Please enter the company. Overtime is counted separately for each company.';
                    statusEl.style.color = '#dc2626';
                    return;
                case !newTitle:
                    statusEl.textContent = 'Please enter a job title.';
                    statusEl.style.color = '#dc2626';
                    return;
                case newCompany.length > 100 || newTitle.length > 100:
                    statusEl.textContent = 'Company and job title must each be 100 characters or less.';
                    statusEl.style.color = '#dc2626';
                    return;
            }

            const { error } = await supabaseClient
                .from('jobs')
                .update({ company: newCompany, job_title: newTitle })
                .eq('id', userJob.id)
                .eq('user_id', currentUser.userId);

            if (error) {
                statusEl.textContent = 'Error: ' + error.message;
                statusEl.style.color = '#dc2626';
                return;
            }

            // the database is updated, so now we update the page to match.
            // a company change can move hours between overtime groups, so the totals are recalculated too
            userJob.company = newCompany;
            userJob.job_title = newTitle;
            showJobInHeader();
            document.getElementById('edit-job-form').style.display = 'none';
            await refreshTotals();
        });

        // ---------- MONTHLY INCOME CHART ----------

        // returns { start, end, label } for the Nth month back from today (0 = current month)
        function getMonthRange(monthsAgo) {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
            const end = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
            const label = start.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
            return { start, end, label };
        }

        // NOTE: computeShiftPayWithOvertime and fetchBreaksByShiftId now live in
        // shared.js (they used to be defined here, but were identical to the
        // copies in budget.js/myprofile.js/shifts.js, so they've been consolidated).

        async function computeMonthlyBreakdown() {
            const labels = [];
            const wageData = [];
            const commissionData = [];

            // earliest month we need, so we only fetch each table once instead of per-month
            const earliest = getMonthRange(MONTHS_BACK - 1).start;

            const { data: shifts } = await supabaseClient
                .from('shifts')
                .select('id, job_id, clock_in, clock_out, jobs(hourly_wage, company)')
                .eq('user_id', currentUser.userId)
                .not('clock_out', 'is', null)
                .gte('clock_in', earliest.toISOString());

            const { data: commissions } = await supabaseClient
                .from('commissions')
                .select('amount, entry_date')
                .eq('user_id', currentUser.userId)
                .gte('entry_date', earliest.toISOString().split('T')[0]);

            // compute overtime-aware pay per shift once, up front
            const breaksByShiftId = await fetchBreaksByShiftId((shifts || []).map(s => s.id));
            const shiftPayMap = computeShiftPayWithOvertime(shifts || [], breaksByShiftId);

            for (let i = MONTHS_BACK - 1; i >= 0; i--) {
                const { start, end, label } = getMonthRange(i);
                labels.push(label);

                let wageTotal = 0;
                (shifts || []).forEach(s => {
                    const clockIn = new Date(s.clock_in);
                    if (clockIn >= start && clockIn < end) {
                        wageTotal += shiftPayMap.get(s) || 0;
                    }
                });

                let commissionTotal = 0;
                (commissions || []).forEach(c => {
                    const entryDate = parseLocalDate(c.entry_date);
                    if (entryDate >= start && entryDate < end) {
                        commissionTotal += parseFloat(c.amount);
                    }
                });

                const keepShare = showAfterTax['income-monthly-graph'] ? 1 - taxRate / 100 : 1;
                wageData.push(wageTotal * keepShare);
                commissionData.push(commissionTotal * keepShare);
            }

            return { labels, wageData, commissionData };
        }

        async function renderMonthlyChart() {
            const { labels, wageData, commissionData } = await computeMonthlyBreakdown();
            const ctx = document.getElementById('monthly-chart');

            if (monthlyChart) {
                monthlyChart.data.labels = labels;
                monthlyChart.data.datasets[0].data = wageData;
                monthlyChart.data.datasets[1].data = commissionData;
                monthlyChart.update();
                return;
            }

            monthlyChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Wage Earnings',
                            data: wageData,
                            backgroundColor: '#10b981',
                            borderRadius: 6,
                            stack: 'income'
                        },
                        {
                            label: 'Commission',
                            data: commissionData,
                            backgroundColor: '#fbbf24',
                            borderRadius: 6,
                            stack: 'income'
                        }
                    ]
                },
                options: {
                    responsive: true,
                    animation: { duration: 600, easing: 'easeOutQuart' },
                    scales: {
                        x: { stacked: true, grid: { display: false }, ticks: { color: getChartColors().text } },
                        y: {
                            stacked: true,
                            grid: { color: getChartColors().grid },
                            ticks: { color: getChartColors().text, callback: (val) => '$' + val }
                        }
                    },
                    plugins: {
                        legend: { position: 'bottom', labels: { color: getChartColors().text } },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => ctx.dataset.label + ': ' + formatMoney(ctx.raw)
                            }
                        }
                    }
                }
            });
        }

        // ---------- NAV LOGOUT ----------
        document.getElementById('nav-logout-btn').addEventListener('click', async () => {
            await supabaseClient.auth.signOut();
            window.location.href = 'login.html';
        });

        // ============================================================
        // WORK + COMMISSION TRACKER
        // (added to match valdyrpierre.github.io/budget/homepage.html)
        // ============================================================
        // Design notes:
        // - phones_repaired / insurance_signups / total_customers /
        //   five_star_reviews are stored in the "daily_metrics" table. there is
        //   no Daily Entry form on this page anymore, so nothing adds to that
        //   table from here. the Month Totals and the 5-Star Rate only read it.
        // - the $5 per repair and $35 per signup rates below are still used by
        //   the Save Goal Planner to show how many repairs or signups are needed.

        const PHONE_REPAIR_RATE = 5;
        const INSURANCE_SIGNUP_RATE = 35;

        // ---------- INIT for this section ----------
        async function initWorkTracker() {
            // the Daily Summary is already filled in by refreshTotals(), so we start at the weekly snapshot
            await loadMonthCompare();
            await loadYearTotals();
            await loadSaveGoalPlanner();
        }

        // ---------- DAILY SUMMARY ----------
        // first it will get the saved wage and commission for the date, and remember them.
        // then it will show them, and the live timer keeps adding the running shift on top
        async function loadDailySummaryForDate(dateStr) {
            const refDate = parseLocalDate(dateStr);
            const nextDay = new Date(refDate);
            nextDay.setDate(nextDay.getDate() + 1);

            const wagePay = await computeShiftsPay(refDate, nextDay);
            const commissionPay = await computeCommissions(refDate, nextDay);

            summaryBase = { wagePay: wagePay, commissionPay: commissionPay, start: refDate, end: nextDay };
            renderDailySummary();
        }

        // shows the saved wage and commission, plus what the running shift has earned so far
        // if that shift started on the summary's date
        function renderDailySummary()
        {
            if (!summaryBase) return;

            let wagePay = summaryBase.wagePay;

            if (activeShift) {
                const clockIn = new Date(activeShift.clock_in);
                if (clockIn >= summaryBase.start && clockIn < summaryBase.end) {
                    wagePay += liveShiftWage;
                }
            }

            document.getElementById('summary-hourly-pay').textContent = formatMoney(wagePay);
            document.getElementById('summary-commission-pay').textContent = formatMoney(summaryBase.commissionPay);
            document.getElementById('summary-total-daily').textContent = formatMoney(wagePay + summaryBase.commissionPay);
        }

        // ---------- LAST 7 DAYS (the clickable bars in the top card) ----------
        // first it will get the wage + commission of each of the last 7 days (today is the last bar),
        // then it will draw one bar per day. clicking a bar puts that date in "Viewing:" and reloads the page numbers
        async function loadRecentDays()
        {
            const today = parseLocalDate(todayStr());
            const ranges = [];

            for (let back = 6; back >= 0; back--) {
                const start = new Date(today);
                start.setDate(start.getDate() - back);
                const end = new Date(start);
                end.setDate(end.getDate() + 1);
                ranges.push({ start: start, end: end });
            }

            const amounts = await Promise.all(ranges.map(async (range) => {
                const wage = await computeShiftsPay(range.start, range.end);
                const commission = await computeCommissions(range.start, range.end);
                return wage + commission;
            }));

            recentDays = ranges.map((range, index) => ({ date: dateToStr(range.start), amount: amounts[index] }));
            renderRecentDays();
        }

        // builds one bar button. the height is the day's share of the best day in the 7
        function buildRecentDayBar(day, bestAmount, keepShare)
        {
            const shown = day.amount * keepShare;
            const date = parseLocalDate(day.date);

            const bar = document.createElement('button');
            bar.type = 'button';
            bar.className = 'rd-bar';
            bar.dataset.date = day.date;
            bar.title = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ': ' + formatMoney(shown);

            if (day.date === todayStr()) bar.classList.add('today');
            if (day.date === document.getElementById('view-date').value) bar.classList.add('selected');
            if (day.amount <= 0) bar.classList.add('empty');

            const amount = document.createElement('span');
            amount.className = 'rd-amount';
            amount.textContent = shown > 0 ? '$' + Math.round(shown) : '';

            const track = document.createElement('span');
            track.className = 'rd-track';
            const fill = document.createElement('span');
            fill.className = 'rd-fill';
            fill.style.height = bestAmount > 0 ? Math.max(day.amount / bestAmount * 100, day.amount > 0 ? 6 : 0) + '%' : '0%';
            track.appendChild(fill);

            const name = document.createElement('span');
            name.className = 'rd-day';
            name.textContent = date.toLocaleDateString(undefined, { weekday: 'short' });

            bar.appendChild(amount);
            bar.appendChild(track);
            bar.appendChild(name);
            return bar;
        }

        function renderRecentDays()
        {
            const list = document.getElementById('recent-days');
            if (!list) return;

            const keepShare = showAfterTax['pay-section'] ? 1 - taxRate / 100 : 1;
            const bestAmount = Math.max(0, ...recentDays.map(day => day.amount));

            list.innerHTML = '';
            recentDays.forEach(day => list.appendChild(buildRecentDayBar(day, bestAmount, keepShare)));
        }

        // a click on a bar changes the "Viewing:" date and presses the View button for the user
        addListener('recent-days', 'click', (event) => {
            const bar = event.target.closest('.rd-bar');
            if (!bar) return;

            document.getElementById('view-date').value = bar.dataset.date;
            document.getElementById('view-date-btn').click();
        });

        // ---------- CHART COLORS (dark / light) ----------
        // the chart draws on a canvas, so the page colors can't reach it. this hands it the right text + grid colors
        function getChartColors()
        {
            const isDark = document.body.classList.contains('dark');
            return {
                text: isDark ? '#94a3b8' : '#64748b',
                grid: isDark ? 'rgba(148, 163, 184, 0.12)' : 'rgba(100, 116, 139, 0.15)'
            };
        }

        function applyChartTheme()
        {
            if (!monthlyChart) return;
            const colors = getChartColors();

            monthlyChart.options.scales.x.ticks.color = colors.text;
            monthlyChart.options.scales.y.ticks.color = colors.text;
            monthlyChart.options.scales.y.grid.color = colors.grid;
            monthlyChart.options.plugins.legend.labels.color = colors.text;
            monthlyChart.update();
        }

        document.addEventListener('themechange', applyChartTheme);

        // ---------- MONTH TOTALS (COMPARE) ----------
        async function loadMonthCompare() {
            const now = new Date();
            const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

            await fillMonthCompareColumn(thisMonthStart, nextMonthStart, 'this');
            await fillMonthCompareColumn(lastMonthStart, thisMonthStart, 'last');
        }

        async function fillMonthCompareColumn(start, end, prefix) {
            const wagePay = await computeShiftsPay(start, end);
            const commissionPay = await computeCommissions(start, end);
            document.getElementById(`compare-${prefix}-money`).textContent = formatMoney(wagePay + commissionPay);
        }

        // ---------- YEAR TOTALS ----------
        async function loadYearTotals() {
            const now = new Date();
            const yearStart = new Date(now.getFullYear(), 0, 1);

            const wagePay = await computeShiftsPay(yearStart, getTomorrowStart());
            const commissionPay = await computeCommissions(yearStart, getTomorrowStart());
            const total = wagePay + commissionPay;

            const { data: shifts } = await supabaseClient
                .from('shifts')
                .select('clock_in, clock_out')
                .eq('user_id', currentUser.userId)
                .not('clock_out', 'is', null)
                .gte('clock_in', yearStart.toISOString());

            const totalHours = (shifts || []).reduce((sum, s) => {
                return sum + (new Date(s.clock_out) - new Date(s.clock_in)) / (1000 * 60 * 60);
            }, 0);

            const monthsElapsed = now.getMonth() + 1;
            const avgPerMonth = total / monthsElapsed;

            document.getElementById('year-money').textContent = formatMoney(total);
            document.getElementById('year-hours').textContent = totalHours.toFixed(2);
            document.getElementById('year-avg-month').textContent = formatMoney(avgPerMonth);
        }

        // ---------- SAVE GOAL PLANNER ----------
        document.getElementById('goal-amount').addEventListener('input', loadSaveGoalPlanner);

        async function loadSaveGoalPlanner() {
            const goal = parseFloat(document.getElementById('goal-amount').value) || 0;
            const now = new Date();
            const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
            const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

            // reuse the existing bills table — bills due this month
            const { data: bills } = await supabaseClient
                .from('bills')
                .select('*')
                .eq('user_id', currentUser.userId)
                .gte('due_date', monthStart.toISOString().split('T')[0])
                .lt('due_date', monthEnd.toISOString().split('T')[0]);

            const billsList = document.getElementById('goal-bills-list');
            billsList.innerHTML = '';
            let totalBills = 0;
            let billsPaid = 0;

            (bills || []).forEach(bill => {
                const amt = parseFloat(bill.amount);
                totalBills += amt;
                if (bill.paid) billsPaid += amt;

                const row = document.createElement('div');
                row.className = 'goal-bill-row';
                row.textContent = `${bill.name} — ${formatMoney(amt)}${bill.paid ? ' (paid)' : ''}`;
                billsList.appendChild(row);
            });

            if (!bills || bills.length === 0) {
                billsList.textContent = 'No bills found for this month.';
            }

            const billsLeft = totalBills - billsPaid;

            document.getElementById('goal-total-bills').textContent = formatMoney(totalBills);
            document.getElementById('goal-bills-paid').textContent = formatMoney(billsPaid);
            document.getElementById('goal-bills-left').textContent = formatMoney(billsLeft);

            const wagePay = await computeShiftsPay(monthStart, getTomorrowStart());
            const commissionPay = await computeCommissions(monthStart, getTomorrowStart());
            const incomeThisMonth = wagePay + commissionPay;

            const target = goal + totalBills;
            const progressPercent = target > 0 ? Math.min((incomeThisMonth / target) * 100, 100) : 0;
            document.getElementById('goal-progress-fill').style.width = progressPercent + '%';
            document.getElementById('goal-progress-label').textContent = `Goal Progress: ${progressPercent.toFixed(0)}%`;

            const needed = Math.max(0, target - incomeThisMonth);
            document.getElementById('goal-income-month').textContent = formatMoney(incomeThisMonth);
            document.getElementById('goal-needed').textContent = formatMoney(needed);

            const job = getSelectedJob();
            const wage = job ? parseFloat(job.hourly_wage) : 0;
            document.getElementById('goal-hours-needed').textContent = wage > 0 ? (needed / wage).toFixed(2) : '—';
            document.getElementById('goal-repairs-needed').textContent = Math.ceil(needed / PHONE_REPAIR_RATE);
            document.getElementById('goal-signups-needed').textContent = Math.ceil(needed / INSURANCE_SIGNUP_RATE);
        }

        // ============================================================
        // WEEKLY SCHEDULE — the shifts the user is scheduled to work: week view, copy the week, estimate
        // ============================================================
        let scheduledShifts = [];     // the scheduled shifts around the week on screen (the month for the estimate too)
        let scheduleWeekStart = null; // the Sunday of the week on screen
        let scheduleBills = [];       // the bills due in the month the estimate is for (null if they could not be loaded)
        const MAX_COPY_WEEKS = 12;
        let editingShiftId = null;    // the id of the scheduled shift being edited (null = the form adds a new shift)
        let toastTimer = null;        // the timer that hides the small message at the bottom of the schedule

        // Turns a Date into a "YYYY-MM-DD" string using the local date.
        function dateToStr(date)
        {
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${date.getFullYear()}-${month}-${day}`;
        }

        // Returns a new Date that is N days after (or before, if N is negative) the given one.
        function addDays(date, days)
        {
            const result = new Date(date);
            result.setDate(result.getDate() + days);
            return result;
        }

        // "14:30" or "14:30:00" -> 870 (minutes since midnight)
        function timeToMinutes(timeStr)
        {
            const [hours, minutes] = timeStr.split(':').map(Number);
            return hours * 60 + minutes;
        }

        // "14:30:00" -> "2:30 PM"
        function formatClock(timeStr)
        {
            const [hours, minutes] = timeStr.split(':').map(Number);
            const suffix = hours < 12 ? 'AM' : 'PM';
            return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
        }

        // Minutes between the start and the end of a shift. If the end is not after the start,
        // the shift goes past midnight, so a day is added. The unpaid break is NOT taken out here.
        function getRawShiftMinutes(shift)
        {
            const minutes = timeToMinutes(shift.end_time) - timeToMinutes(shift.start_time);
            return minutes > 0 ? minutes : minutes + 24 * 60;
        }

        // Paid hours of a scheduled shift: the length of the shift minus the unpaid break.
        function getScheduledHours(shift)
        {
            return Math.max(0, getRawShiftMinutes(shift) - (shift.break_minutes || 0)) / 60;
        }

        // Finds one of the user's jobs by its id.
        function getScheduleJob(jobId)
        {
            return userJobs.find(job => String(job.id) === String(jobId));
        }

        // Gets the scheduled shifts of the user with a shift date from fromDate up to (not including) toDate.
        // Returns null if they could not be loaded (for example the table was not created yet).
        async function obtainScheduledShifts(fromDate, toDate)
        {
            const { data, error } = await supabaseClient
                .from('scheduled_shifts')
                .select('*')
                .eq('user_id', currentUser.userId)
                .gte('shift_date', dateToStr(fromDate))
                .lt('shift_date', dateToStr(toDate))
                .order('shift_date', { ascending: true })
                .order('start_time', { ascending: true });

            if (error) {
                console.error('Could not load the schedule:', error);
                return null;
            }
            return data || [];
        }

        // Saves new scheduled shifts (one row, or a whole copied week).
        async function addScheduledShifts(rows)
        {
            const { error } = await supabaseClient.from('scheduled_shifts').insert(rows);
            return error;
        }

        // Deletes one scheduled shift.
        async function deleteScheduledShift(shiftId)
        {
            const { error } = await supabaseClient
                .from('scheduled_shifts')
                .delete()
                .eq('id', shiftId)
                .eq('user_id', currentUser.userId);
            return error;
        }

        // Changes the times, job, date or break of one scheduled shift.
        async function updateScheduledShift(shiftId, changes)
        {
            const { error } = await supabaseClient
                .from('scheduled_shifts')
                .update(changes)
                .eq('id', shiftId)
                .eq('user_id', currentUser.userId);
            return error;
        }

        // Deletes every scheduled shift of the week on screen.
        async function deleteScheduledWeek(weekStart)
        {
            const { error } = await supabaseClient
                .from('scheduled_shifts')
                .delete()
                .eq('user_id', currentUser.userId)
                .gte('shift_date', dateToStr(weekStart))
                .lt('shift_date', dateToStr(addDays(weekStart, 7)));
            return error;
        }

        // Gets the bills that are due in the month (paid or not), so we can compare them with the schedule.
        // Returns null if they could not be loaded.
        async function obtainMonthBills(monthStart, monthEnd)
        {
            const { data, error } = await supabaseClient
                .from('bills')
                .select('amount, due_date')
                .eq('user_id', currentUser.userId)
                .gte('due_date', dateToStr(monthStart))
                .lt('due_date', dateToStr(monthEnd));

            if (error) {
                console.error('Could not load the bills for the schedule:', error);
                return null;
            }
            return data || [];
        }

        // ---------- ESTIMATE ----------

        // Dresses a scheduled shift up as a normal shift (clock in, clock out, job wage), so the SAME
        // overtime function that calculates the real pay can calculate the estimate.
        function buildPayShift(shift)
        {
            const job = getScheduleJob(shift.job_id);
            const clockIn = localDateWithTime(shift.shift_date, shift.start_time);
            const clockOut = new Date(clockIn.getTime() + getRawShiftMinutes(shift) * 60000);

            return {
                id: shift.id,
                job_id: shift.job_id,
                clock_in: clockIn.toISOString(),
                clock_out: clockOut.toISOString(),
                jobs: job ? { hourly_wage: job.hourly_wage, company: job.company } : null
            };
        }

        // "2026-10-23" + "09:30:00" -> a local Date on that day at that time
        function localDateWithTime(dateStr, timeStr)
        {
            const date = parseLocalDate(dateStr);
            date.setHours(0, timeToMinutes(timeStr), 0, 0);
            return date;
        }

        // Calculates the estimated pay of every scheduled shift, with the 40 hour overtime rule
        // per company per week and the unpaid breaks. Returns a Map: shift id -> pay.
        function calculateSchedulePay(shifts)
        {
            const payShifts = shifts.map(buildPayShift);

            // the unpaid break of each shift is given to the overtime function as a break that starts at clock in
            const breaksByShiftId = new Map();
            payShifts.forEach((payShift, index) => {
                const breakMs = (shifts[index].break_minutes || 0) * 60000;
                const breakEnd = new Date(new Date(payShift.clock_in).getTime() + breakMs).toISOString();
                breaksByShiftId.set(payShift.id, [{ break_start: payShift.clock_in, break_end: breakEnd }]);
            });

            const payByShift = computeShiftPayWithOvertime(payShifts, breaksByShiftId);

            const payById = new Map();
            payShifts.forEach(payShift => payById.set(payShift.id, payByShift.get(payShift) || 0));
            return payById;
        }

        // Adds up the hours and the pay of the scheduled shifts dated from fromDate up to toDate.
        function summarizeSchedule(shifts, payById, fromDate, toDate)
        {
            const from = dateToStr(fromDate);
            const to = dateToStr(toDate);
            const inRange = shifts.filter(shift => shift.shift_date >= from && shift.shift_date < to);

            return {
                hours: inRange.reduce((sum, shift) => sum + getScheduledHours(shift), 0),
                pay: inRange.reduce((sum, shift) => sum + (payById.get(shift.id) || 0), 0)
            };
        }

        // The month the estimate is for: the month most of the week on screen is in (its Wednesday).
        function getScheduleMonthRange()
        {
            const middle = addDays(scheduleWeekStart, 3);
            return {
                start: new Date(middle.getFullYear(), middle.getMonth(), 1),
                end: new Date(middle.getFullYear(), middle.getMonth() + 1, 1)
            };
        }

        // ---------- SMALL MESSAGES + REMEMBERED TIMES ----------

        // Shows a small message at the bottom of the schedule for a few seconds, instead of a pop-up box.
        // If an undo function is given, the message also has an Undo button.
        function showScheduleToast(message, undoHandler)
        {
            const toast = document.getElementById('sched-toast');
            if (!toast) return;

            toast.innerHTML = '';
            toast.appendChild(buildScheduleElement('span', 'sched-toast-text', message));

            if (undoHandler) {
                const undoButton = buildScheduleElement('button', 'sched-toast-undo', 'Undo');
                undoButton.type = 'button';
                undoButton.addEventListener('click', async () => {
                    toast.classList.remove('show');
                    await undoHandler();
                });
                toast.appendChild(undoButton);
            }

            toast.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => toast.classList.remove('show'), undoHandler ? 8000 : 4000);
        }

        // Remembers the job and times of the last shift that was added, so the next one starts filled in.
        // (the browser storage can be turned off, so nothing here may crash the page)
        function rememberScheduleDefaults(form)
        {
            try {
                localStorage.setItem('scheduleDefaults', JSON.stringify({ jobId: form.jobId, start: form.start, end: form.end, breakMinutes: form.breakMinutes }));
            } catch (err) {
                console.warn('Could not remember the schedule times:', err);
            }
        }

        // Fills the Add Shift form with the times of the last shift that was added.
        function applyScheduleDefaults()
        {
            try {
                const saved = JSON.parse(localStorage.getItem('scheduleDefaults') || 'null');
                if (!saved) return;

                if (saved.start) document.getElementById('sched-start').value = saved.start;
                if (saved.end) document.getElementById('sched-end').value = saved.end;
                document.getElementById('sched-break').value = saved.breakMinutes || 0;
                if (saved.jobId && getScheduleJob(saved.jobId)) document.getElementById('sched-job').value = saved.jobId;
            } catch (err) {
                console.warn('Could not read the remembered schedule times:', err);
            }
        }

        // ---------- LOAD + DRAW ----------

        // Loads the scheduled shifts that the week on screen AND the month estimate need, then draws everything.
        async function loadSchedule()
        {
            const month = getScheduleMonthRange();
            const weekEnd = addDays(scheduleWeekStart, 7);

            // from the Sunday that starts the month's first week (the earlier shifts of that week count for overtime)
            const fromDate = new Date(Math.min(getWeekStartDate(month.start), scheduleWeekStart));
            const toDate = new Date(Math.max(month.end, weekEnd));

            const shifts = await obtainScheduledShifts(fromDate, toDate);
            if (shifts === null) {
                document.getElementById('sched-week-grid').textContent = 'Could not load the schedule. Run schedule-setup.sql in Supabase one time (SQL Editor), then refresh.';
                return;
            }

            scheduledShifts = shifts;
            scheduleBills = await obtainMonthBills(month.start, month.end);
            renderSchedule();
        }

        // Builds one small element with the given tag, class and text.
        function buildScheduleElement(tagName, className, text)
        {
            const element = document.createElement(tagName);
            element.className = className;
            element.textContent = text;
            return element;
        }

        // Builds the box of one scheduled shift: the times, the job, the paid hours and a delete button.
        function buildScheduleChip(shift)
        {
            const job = getScheduleJob(shift.job_id);
            const chip = buildScheduleElement('div', 'sched-chip', '');

            chip.appendChild(buildScheduleElement('span', 'sched-chip-time', formatClock(shift.start_time) + ' – ' + formatClock(shift.end_time)));
            chip.appendChild(buildScheduleElement('span', 'sched-chip-job', job ? jobLabel(job) : 'Deleted job'));
            chip.appendChild(buildScheduleElement('span', 'sched-chip-hours', getScheduledHours(shift).toFixed(2) + ' hrs'));

            const deleteButton = buildScheduleElement('button', 'sched-chip-delete', '✕');
            deleteButton.type = 'button';
            deleteButton.title = 'Delete this shift';
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation(); // so the click does not also open the shift for editing
                handleDeleteScheduledShift(shift);
            });
            chip.appendChild(deleteButton);

            // clicking the shift loads it into the form to change it
            chip.title = 'Click to edit this shift';
            chip.addEventListener('click', () => startEditingShift(shift));

            return chip;
        }

        // Builds one day of the week: the day name, the date, and the shifts of that day.
        function buildScheduleDay(date)
        {
            const dayShifts = scheduledShifts.filter(shift => shift.shift_date === dateToStr(date));

            const day = buildScheduleElement('div', 'sched-day', '');
            if (dateToStr(date) === todayStr()) day.classList.add('today');

            day.appendChild(buildScheduleElement('span', 'sched-day-name', date.toLocaleDateString(undefined, { weekday: 'short' })));
            day.appendChild(buildScheduleElement('span', 'sched-day-date', date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));

            if (dayShifts.length === 0) day.appendChild(buildScheduleElement('span', 'sched-day-off', 'Off'));
            dayShifts.forEach(shift => day.appendChild(buildScheduleChip(shift)));

            // the + button opens the form for this day
            const addButton = buildScheduleElement('button', 'sched-day-add', '+ Add');
            addButton.type = 'button';
            addButton.title = 'Add a shift on this day';
            addButton.addEventListener('click', () => startAddingShiftOn(dateToStr(date)));
            day.appendChild(addButton);

            return day;
        }

        // Draws the seven days of the week on screen.
        function renderWeekGrid()
        {
            const grid = document.getElementById('sched-week-grid');
            grid.innerHTML = '';

            for (let i = 0; i < 7; i++) {
                grid.appendChild(buildScheduleDay(addDays(scheduleWeekStart, i)));
            }
        }

        // Writes the label between the arrows: "Oct 18 – Oct 24".
        function renderWeekLabel()
        {
            const options = { month: 'short', day: 'numeric' };
            const first = scheduleWeekStart.toLocaleDateString(undefined, options);
            const last = addDays(scheduleWeekStart, 6).toLocaleDateString(undefined, options);

            // the hours scheduled in this week are shown next to the dates
            const weekStartStr = dateToStr(scheduleWeekStart);
            const weekEndStr = dateToStr(addDays(scheduleWeekStart, 7));
            const weekHours = scheduledShifts
                .filter(shift => shift.shift_date >= weekStartStr && shift.shift_date < weekEndStr)
                .reduce((sum, shift) => sum + getScheduledHours(shift), 0);

            document.getElementById('sched-week-label').textContent = `${first} – ${last}  •  ${weekHours.toFixed(1)} hrs scheduled`;
        }

        // Fills the hours and estimated pay of the week on screen and of the month. "After tax" uses
        // the same tax % box as the rest of the dashboard.
        function renderScheduleSummary()
        {
            const payById = calculateSchedulePay(scheduledShifts);
            const keepShare = 1 - taxRate / 100;
            const month = getScheduleMonthRange();

            const week = summarizeSchedule(scheduledShifts, payById, scheduleWeekStart, addDays(scheduleWeekStart, 7));
            const monthTotals = summarizeSchedule(scheduledShifts, payById, month.start, month.end);

            document.getElementById('sched-week-hours').textContent = week.hours.toFixed(2);
            document.getElementById('sched-week-pay').textContent = formatMoney(week.pay);
            document.getElementById('sched-week-net').textContent = formatMoney(week.pay * keepShare);

            document.getElementById('sched-month-label').textContent = month.start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) + ' (all scheduled shifts)';
            document.getElementById('sched-month-hours').textContent = monthTotals.hours.toFixed(2);
            document.getElementById('sched-month-pay').textContent = formatMoney(monthTotals.pay);
            document.getElementById('sched-month-net').textContent = formatMoney(monthTotals.pay * keepShare);

            // the bills are paid from the money after tax, so the comparison uses the after tax number
            renderBillsGap(monthTotals.pay * keepShare, month);
        }

        // How many weeks are in the month: the days of the month divided by 7 (31 days = 4.43 weeks).
        function getWeeksInMonth(month)
        {
            const daysInMonth = Math.round((month.end - month.start) / 86400000);
            return daysInMonth / 7;
        }

        // Compares the bills of the month with the expected take-home of the scheduled shifts, week by week:
        // - the bills of the month divided by the weeks of the month = what must be earned each week
        // - the take-home of the scheduled shifts divided by the weeks = what the schedule brings in each week
        // If the schedule brings in less, it shows how much more is needed per week. If it brings in
        // more, it shows how much money would be left over for the month after paying all the bills.
        function renderBillsGap(expectedTakeHome, month)
        {
            const monthName = month.start.toLocaleDateString(undefined, { month: 'long' });
            const box = document.getElementById('sched-gap-box');

            document.getElementById('sched-bills-label').textContent = 'Bills vs. your schedule — ' + monthName;

            if (scheduleBills === null) {
                ['sched-bills-total', 'sched-need-week', 'sched-have-week', 'sched-gap-amount'].forEach(id => {
                    document.getElementById(id).textContent = '—';
                });
                document.getElementById('sched-gap-title').textContent = 'Bills not loaded';
                document.getElementById('sched-gap-detail').textContent = 'Could not load your bills. Press F12 to see why.';
                box.className = 'summary-box sched-gap-box';
                return;
            }

            const weeksInMonth = getWeeksInMonth(month);
            const billsTotal = scheduleBills.reduce((sum, bill) => sum + parseFloat(bill.amount), 0);
            const neededPerWeek = billsTotal / weeksInMonth;
            const scheduledPerWeek = expectedTakeHome / weeksInMonth;
            const weeksText = weeksInMonth.toFixed(1) + ' weeks';

            document.getElementById('sched-bills-total').textContent = formatMoney(billsTotal);
            document.getElementById('sched-need-week').textContent = formatMoney(neededPerWeek);
            document.getElementById('sched-have-week').textContent = formatMoney(scheduledPerWeek);

            const startOfDetail = `${monthName} has ${weeksText}. Your ${formatMoney(billsTotal)} of bills divided by ${weeksText} means you need to earn ${formatMoney(neededPerWeek)} each week. Your scheduled shifts bring in about ${formatMoney(scheduledPerWeek)} a week after tax`;

            if (scheduledPerWeek >= neededPerWeek) {
                const leftOver = expectedTakeHome - billsTotal;
                box.className = 'summary-box sched-gap-box gap-ok';
                document.getElementById('sched-gap-title').textContent = 'Left over this month';
                document.getElementById('sched-gap-amount').textContent = formatMoney(leftOver);
                document.getElementById('sched-gap-detail').textContent =
                    `${startOfDetail}, which covers it. If you work every scheduled shift you would have ${formatMoney(leftOver)} left over (${formatMoney(leftOver / weeksInMonth)} a week) after paying all your bills.`;
                return;
            }

            const extraPerWeek = neededPerWeek - scheduledPerWeek;
            box.className = 'summary-box sched-gap-box gap-short';
            document.getElementById('sched-gap-title').textContent = 'Extra needed per week';
            document.getElementById('sched-gap-amount').textContent = formatMoney(extraPerWeek);
            document.getElementById('sched-gap-detail').textContent =
                `${startOfDetail}, so you would need about ${formatMoney(extraPerWeek)} more each week on top of your pay (${formatMoney(extraPerWeek * weeksInMonth)} for the month) to pay all your bills.`;
        }

        // Draws the whole schedule section.
        function renderSchedule()
        {
            renderWeekLabel();
            renderWeekGrid();
            renderScheduleSummary();
        }

        // Fills the job dropdown of the Add Shift form with all the user's jobs.
        function renderScheduleJobOptions()
        {
            const select = document.getElementById('sched-job');
            select.innerHTML = '';

            userJobs.forEach(job => {
                const option = document.createElement('option');
                option.value = job.id;
                option.textContent = jobLabel(job);
                option.selected = userJob && String(job.id) === String(userJob.id);
                select.appendChild(option);
            });
        }

        // ---------- ADD A SHIFT ----------

        // Checks the Add Shift form. Returns the first problem it finds, or an empty string.
        function validateScheduleForm(form)
        {
            switch (true) {
                case !form.jobId:
                    return 'Please choose a job.';
                case !form.date:
                    return 'Please choose a date.';
                case !form.start || !form.end:
                    return 'Please enter a start and an end time.';
                case form.start === form.end:
                    return 'The start and the end time cannot be the same.';
                case isNaN(form.breakMinutes) || form.breakMinutes < 0:
                    return 'The unpaid break must be 0 or more minutes.';
                case form.breakMinutes >= getRawShiftMinutes({ start_time: form.start, end_time: form.end }):
                    return 'The unpaid break is longer than the shift.';
                default:
                    return '';
            }
        }

        // Puts the form in "add" mode for the given day: today's remembered times, the day filled in, and the
        // cursor on the start time.
        function startAddingShiftOn(dateStr)
        {
            stopEditingShift();
            document.getElementById('sched-date').value = dateStr;
            document.getElementById('sched-add-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
            document.getElementById('sched-start').focus();
        }

        // Puts the form in "edit" mode: the shift's own job, date and times are loaded, and the button says Save Changes.
        function startEditingShift(shift)
        {
            editingShiftId = shift.id;

            document.getElementById('sched-job').value = shift.job_id;
            document.getElementById('sched-date').value = shift.shift_date;
            document.getElementById('sched-start').value = shift.start_time.slice(0, 5);
            document.getElementById('sched-end').value = shift.end_time.slice(0, 5);
            document.getElementById('sched-break').value = shift.break_minutes || 0;

            document.getElementById('sched-form-title').textContent = 'Edit shift';
            document.getElementById('sched-submit').value = 'Save Changes';
            document.getElementById('sched-cancel-edit').style.display = 'inline-block';
            document.getElementById('sched-add-form').classList.add('editing');
            document.getElementById('sched-add-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // Puts the form back in "add" mode (used after saving, cancelling, or clicking a + button).
        function stopEditingShift()
        {
            editingShiftId = null;
            document.getElementById('sched-form-title').textContent = 'Add a shift';
            document.getElementById('sched-submit').value = 'Add Shift';
            document.getElementById('sched-cancel-edit').style.display = 'none';
            document.getElementById('sched-add-form').classList.remove('editing');
            document.getElementById('sched-form-status').textContent = '';
        }

        addListener('sched-cancel-edit', 'click', () => {
            stopEditingShift();
            applyScheduleDefaults();
        });

        // First it checks the form, then it saves the shift (a new one, or the changes of the one being edited),
        // remembers the times for the next shift, and shows the week of that shift.
        addListener('sched-add-form', 'submit', async (e) => {
            e.preventDefault();

            const statusEl = document.getElementById('sched-form-status');
            statusEl.textContent = '';

            const form = {
                jobId: document.getElementById('sched-job').value,
                date: document.getElementById('sched-date').value,
                start: document.getElementById('sched-start').value,
                end: document.getElementById('sched-end').value,
                breakMinutes: parseInt(document.getElementById('sched-break').value || '0', 10)
            };

            const problem = validateScheduleForm(form);
            if (problem) {
                statusEl.textContent = problem;
                return;
            }

            const row = {
                job_id: form.jobId,
                shift_date: form.date,
                start_time: form.start,
                end_time: form.end,
                break_minutes: form.breakMinutes
            };

            const wasEditing = editingShiftId !== null;
            const error = wasEditing
                ? await updateScheduledShift(editingShiftId, row)
                : await addScheduledShifts([{ ...row, user_id: currentUser.userId }]);

            if (error) {
                statusEl.textContent = 'Error saving shift: ' + error.message;
                return;
            }

            rememberScheduleDefaults(form);
            stopEditingShift();
            showScheduleToast(wasEditing ? 'Shift updated.' : 'Shift added.');

            // jump to the week of the saved shift so the user sees it right away
            scheduleWeekStart = getWeekStartDate(parseLocalDate(form.date));
            await loadSchedule();
        });

        // ---------- DELETE ----------

        // Deletes one scheduled shift right away and shows an Undo button for a few seconds
        // (undo puts the same shift back), so there is no "are you sure" box to click through.
        async function handleDeleteScheduledShift(shift)
        {
            const error = await deleteScheduledShift(shift.id);
            if (error) return showScheduleToast('Error deleting shift: ' + error.message);

            if (editingShiftId === shift.id) stopEditingShift();

            showScheduleToast('Shift deleted.', async () => {
                const restoreError = await addScheduledShifts([{
                    user_id: currentUser.userId,
                    job_id: shift.job_id,
                    shift_date: shift.shift_date,
                    start_time: shift.start_time,
                    end_time: shift.end_time,
                    break_minutes: shift.break_minutes
                }]);

                if (restoreError) return showScheduleToast('Could not undo: ' + restoreError.message);
                await loadSchedule();
            });

            await loadSchedule();
        }

        // Asks first, then deletes every scheduled shift of the week on screen.
        addListener('sched-clear-week', 'click', async () => {
            const weekShifts = scheduledShifts.filter(shift => shift.shift_date >= dateToStr(scheduleWeekStart) && shift.shift_date < dateToStr(addDays(scheduleWeekStart, 7)));
            if (weekShifts.length === 0) return showScheduleToast('There are no scheduled shifts in this week.');

            if (!confirm(`Delete all ${weekShifts.length} scheduled shift(s) of this week?`)) return;

            const error = await deleteScheduledWeek(scheduleWeekStart);
            if (error) return showScheduleToast('Error clearing the week: ' + error.message);

            showScheduleToast('Week cleared.');
            await loadSchedule();
        });

        // ---------- COPY THE WEEK ----------

        // The same shift on the same day, job and times (used to not copy a shift twice).
        function getShiftKey(jobId, dateStr, startTime, endTime)
        {
            return [jobId, dateStr, startTime.slice(0, 5), endTime.slice(0, 5)].join('|');
        }

        // Builds the rows of the copied weeks: every shift of the week on screen, moved 7, 14, 21... days later.
        function buildCopiedRows(weekShifts, weeksCount)
        {
            const rows = [];

            for (let week = 1; week <= weeksCount; week++) {
                weekShifts.forEach(shift => {
                    rows.push({
                        user_id: currentUser.userId,
                        job_id: shift.job_id,
                        shift_date: dateToStr(addDays(parseLocalDate(shift.shift_date), week * 7)),
                        start_time: shift.start_time,
                        end_time: shift.end_time,
                        break_minutes: shift.break_minutes
                    });
                });
            }
            return rows;
        }

        // First it checks the number of weeks, then it builds the copies and skips the ones that
        // already exist, then it saves the rest and shows the next week.
        async function copyWeekIntoNextWeeks(weeksCount)
        {
            const weekStartStr = dateToStr(scheduleWeekStart);
            const weekEndStr = dateToStr(addDays(scheduleWeekStart, 7));
            const weekShifts = scheduledShifts.filter(shift => shift.shift_date >= weekStartStr && shift.shift_date < weekEndStr);

            switch (true) {
                case isNaN(weeksCount) || weeksCount < 1 || weeksCount > MAX_COPY_WEEKS:
                    return showScheduleToast(`Choose between 1 and ${MAX_COPY_WEEKS} weeks.`);
                case weekShifts.length === 0:
                    return showScheduleToast('This week has no scheduled shifts to copy. Add the shifts first.');
            }

            const rows = buildCopiedRows(weekShifts, weeksCount);

            // look at what is already scheduled in the weeks we are about to fill
            const existing = await obtainScheduledShifts(addDays(scheduleWeekStart, 7), addDays(scheduleWeekStart, 7 * (weeksCount + 1)));
            if (existing === null) return showScheduleToast('Could not check the next weeks. Try again.');

            const existingKeys = new Set(existing.map(s => getShiftKey(s.job_id, s.shift_date, s.start_time, s.end_time)));
            const newRows = rows.filter(row => !existingKeys.has(getShiftKey(row.job_id, row.shift_date, row.start_time, row.end_time)));

            if (newRows.length === 0) return showScheduleToast('Those weeks already have these shifts.');

            const error = await addScheduledShifts(newRows);
            if (error) return showScheduleToast('Error copying the week: ' + error.message);

            showScheduleToast(`Copied ${newRows.length} shift(s) into the next ${weeksCount} week(s).`);
            scheduleWeekStart = addDays(scheduleWeekStart, 7);
            await loadSchedule();
        }

        addListener('sched-copy-next', 'click', () => copyWeekIntoNextWeeks(1));

        addListener('sched-copy-btn', 'click', () => copyWeekIntoNextWeeks(parseInt(document.getElementById('sched-copy-weeks').value, 10)));

        // ---------- WEEK ARROWS ----------

        addListener('sched-prev', 'click', async () => {
            scheduleWeekStart = addDays(scheduleWeekStart, -7);
            await loadSchedule();
        });

        addListener('sched-next', 'click', async () => {
            scheduleWeekStart = addDays(scheduleWeekStart, 7);
            await loadSchedule();
        });

        addListener('sched-today', 'click', async () => {
            scheduleWeekStart = getWeekStartDate(new Date());
            await loadSchedule();
        });

        // Starts the schedule: this week on screen, today in the date box, the user's jobs in the dropdown.
        async function initSchedule()
        {
            if (!document.getElementById('sched-week-grid')) return; // the page does not have the schedule section

            scheduleWeekStart = getWeekStartDate(new Date());
            document.getElementById('sched-date').value = todayStr();
            renderScheduleJobOptions();
            applyScheduleDefaults();
            await loadSchedule();
        }

        // initWorkTracker depends on selectedJobId being set by init() first,
        // so it must run after init() fully finishes, not in parallel with it.
        (async () => {
            // if anything inside init() breaks, the page used to just stay on "Loading..." with no clue why.
            // now the error is shown right under the title, and also logged in the console (F12)
            try {
                await init();
                if (currentUser && userJob) {
                    await initWorkTracker();
                    await initSchedule();
                }
            } catch (err) {
                console.error('Dashboard failed to load:', err);
                document.getElementById('job-title-display').textContent = 'Error loading dashboard: ' + err.message;
            }
        })();


// ============================================================
// FINANCE LAYER (top card, count-up numbers, dark / light theme, quick buttons)
// was dashboard-finance.js. it only watches numbers this file already puts on the page.
// it sits OUTSIDE the main function above on purpose, and must stay at the bottom
// ============================================================

// dashboard-finance.js - the "finance app" layer of the dashboard.
// It never touches the database. It only watches the numbers dashboard.js already puts on the page,
// then adds the top card, the count-up numbers, the dark / light theme and the quick buttons.

// ---------- HELPERS ----------

// turns "$1,234.50" or "$-5.00" or "0.00" into a number. returns null if the text is not a number
function parseAmount(text)
{
    const cleaned = String(text).replace(/[$,%\s]/g, '');
    if (cleaned === '' || isNaN(cleaned)) return null;
    return parseFloat(cleaned);
}

// one money format for the whole page (shared.js formatMoney): 1234.5 -> "$1,234.50"
function formatDollars(amount)
{
    return formatMoney(amount);
}

// runs the callback now, and again every time the element's text or class changes
function watchElement(element, callback)
{
    if (!element) return;
    new MutationObserver(callback).observe(element, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    callback();
}

// ---------- THEME (dark / light) ----------

function applyTheme(isDark)
{
    document.body.classList.toggle('dark', isDark);
    document.getElementById('theme-toggle').textContent = isDark ? '☀️' : '🌙';
    document.dispatchEvent(new Event('themechange')); // dashboard.js listens, so the chart can recolor itself
}

document.getElementById('theme-toggle').addEventListener('click', () => {
    const goDark = !document.body.classList.contains('dark');
    applyTheme(goDark);

    try { localStorage.setItem('theme', goDark ? 'dark' : 'light'); } catch (e) { /* private window, just don't remember it */ }
});

applyTheme(document.body.classList.contains('dark'));

// ---------- COUNT-UP NUMBERS ----------
// when a money number changes, it rolls from the old value to the new one instead of jumping.
// tiny changes (the live timer adds a few cents every second) just show right away so nothing flickers

const COUNT_UP_IDS = [
    'hero-amount', 'hero-bills', 'hero-gap', 'hero-sched',
    'summary-hourly-pay', 'summary-commission-pay', 'summary-total-daily',
    'compare-this-money', 'compare-last-money', 'year-money', 'year-avg-month'
];

// rolls one number. every roll gets a ticket number, so if a newer number arrives the older roll stops
function rollNumber(element, from, to)
{
    const ticket = (element.__ticket || 0) + 1;
    element.__ticket = ticket;

    const startTime = performance.now();
    const duration = 650;

    function frame(now)
    {
        if (element.__ticket !== ticket) return; // a newer roll took over

        const progress = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // fast at first, slow at the end
        const value = from + (to - from) * eased;

        element.__shown = value;
        element.__written = formatDollars(value);
        element.textContent = element.__written; // remembered, so the watcher below knows this write is ours
        if (progress < 1) requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
}

function handleNumberChange(element)
{
    if (element.textContent === element.__written) return; // our own roll wrote this, ignore it

    const target = parseAmount(element.textContent);
    if (target === null) return;

    const from = element.__shown !== undefined ? element.__shown : 0;

    if (Math.abs(target - from) < 1) {
        element.__ticket = (element.__ticket || 0) + 1; // stop any roll still running
        element.__shown = target;
        return;
    }

    rollNumber(element, from, target);
}

COUNT_UP_IDS.forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    new MutationObserver(() => handleNumberChange(element)).observe(element, { childList: true, characterData: true, subtree: true });
});

// ---------- TOP CARD ----------

let heroPeriod = 'month';

try { heroPeriod = localStorage.getItem('heroPeriod') || 'month'; } catch (e) { /* keep month */ }

function getHeroRangeText()
{
    const viewDate = document.getElementById('view-date').value;
    if (!viewDate) return '';

    const date = new Date(viewDate + 'T00:00:00');

    switch (heroPeriod) {
        case 'day':
            return 'For ' + date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        case 'week':
            return 'For the week of ' + date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        case 'month':
            return 'For ' + date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        default:
            return 'For ' + date.getFullYear();
    }
}

// the green / red arrow compares this month with last month. it only shows on the Month tab
function renderHeroDelta()
{
    const deltaBox = document.getElementById('hero-delta');
    deltaBox.className = 'hero-delta';
    deltaBox.textContent = '';

    if (heroPeriod !== 'month') return;

    const thisMonth = parseAmount(document.getElementById('compare-this-money').textContent);
    const lastMonth = parseAmount(document.getElementById('compare-last-money').textContent);
    if (thisMonth === null || lastMonth === null || (thisMonth === 0 && lastMonth === 0)) return;

    if (lastMonth === 0) {
        deltaBox.classList.add('up');
        deltaBox.textContent = '▲ new this month';
        return;
    }

    const percent = (thisMonth - lastMonth) / lastMonth * 100;
    deltaBox.classList.add(percent >= 0 ? 'up' : 'down');
    deltaBox.textContent = (percent >= 0 ? '▲ ' : '▼ ') + Math.abs(percent).toFixed(1) + '% vs last month';
}

function renderHero()
{
    const source = document.getElementById('total-' + heroPeriod);
    const amount = source ? parseAmount(source.textContent) : null;
    document.getElementById('hero-amount').textContent = amount === null ? '$0.00' : formatDollars(amount);
    document.getElementById('hero-range').textContent = getHeroRangeText();
    renderHeroDelta();
}

function selectHeroPeriod(period)
{
    heroPeriod = period;

    document.querySelectorAll('.hero-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.period === period);
    });

    try { localStorage.setItem('heroPeriod', period); } catch (e) { /* ignore */ }
    renderHero();
}

document.querySelectorAll('.hero-tab').forEach(tab => {
    tab.addEventListener('click', () => selectHeroPeriod(tab.dataset.period));
});

// clicking a box in Totals also switches the top card to that period
document.querySelectorAll('.pay-box').forEach((box, index) => {
    box.classList.add('clickable');
    box.addEventListener('click', () => {
        selectHeroPeriod(['day', 'week', 'month', 'year'][index]);
        document.getElementById('sec-hero').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
});

// the top card follows the numbers in Totals and the month compare boxes
['total-day', 'total-week', 'total-month', 'total-year', 'compare-this-money', 'compare-last-money'].forEach(id => {
    watchElement(document.getElementById(id), renderHero);
});

document.getElementById('view-date').addEventListener('change', renderHero);
document.getElementById('view-date-btn').addEventListener('click', renderHero);

// ---------- THE THREE SMALL BOXES UNDER THE TOP CARD ----------
// they copy what the schedule section already worked out, so the answer is visible without scrolling

function copyText(sourceId, targetId)
{
    watchElement(document.getElementById(sourceId), () => {
        document.getElementById(targetId).textContent = document.getElementById(sourceId).textContent;
    });
}

copyText('sched-bills-total', 'hero-bills');
copyText('sched-week-net', 'hero-sched');
copyText('sched-gap-amount', 'hero-gap');
copyText('sched-gap-title', 'hero-gap-label');

// the "left over / extra needed" box turns green or red together with the schedule one
watchElement(document.getElementById('sched-gap-box'), () => {
    const box = document.getElementById('sched-gap-box');
    const chip = document.getElementById('hero-gap-chip');
    chip.classList.toggle('gap-ok', box.classList.contains('gap-ok'));
    chip.classList.toggle('gap-short', box.classList.contains('gap-short'));
});

// ---------- QUICK COMMISSION AMOUNTS ----------
// a quick button fills in the amount, then the Add button wiggles so you know it is the next tap

document.querySelectorAll('.quick-amount').forEach(button => {
    button.addEventListener('click', () => {
        document.getElementById('commission-input').value = button.dataset.amount;

        const addButton = document.getElementById('add-commission-btn');
        addButton.classList.remove('nudge');
        void addButton.offsetWidth; // restarts the animation if it is tapped twice
        addButton.classList.add('nudge');
        addButton.focus();
    });
});

// ---------- BUTTON PRESS FEEDBACK ----------
// every button gets a small "pressed" look while the finger or mouse is down

document.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button');
    if (button && !button.disabled) button.classList.add('pressed');
});

['pointerup', 'pointercancel', 'pointerleave'].forEach(name => {
    document.addEventListener(name, () => {
        document.querySelectorAll('button.pressed').forEach(button => button.classList.remove('pressed'));
    }, true);
});
