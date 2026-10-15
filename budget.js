// TODO: replace with your actual Supabase project values
        const SUPABASE_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_4ProG0sjTH1-DCh9f5QsUg_L85xilyM';
        const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        let currentUser = null;
        let userJob = null;
        let selectedJobId = null;
        let activeShift = null; // { id, job_id, clock_in }
        let activeBreak = null; // { id, break_start } — the currently-open lunch break, if any
        let liveTimerInterval = null;
        let totalsBase = {}; // before-tax totals from finished shifts + commission, for each period (day/week/month/year)
        let totalsRanges = {}; // start and end dates of each period, so we know which ones the active shift falls inside
        let liveShiftWage = 0; // wage the active shift has earned so far, updated every second by the live timer
        let showAfterTax = { "constantpay": false, "pay-section": false, "income-monthly-graph": false };
        let avgLookupCache = {};        // job_title(lowercase) -> average_wage, fetched once
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

        // this will be responsible for applying tax to the amount earned so far
        // i will use encapsulation to make the code more maintainable and readable
        // i will use this function to apply the massachusetts calculation which is 5% of the amount earned
        function calculateTax(amount, sectionKey) 
        {
            if (showAfterTax[sectionKey]) {
                return amount * 0.95; // 5% tax deduction
            }
            // this amount will be shown whenever the user wants to see the amount after tax
            return amount;
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

            // second we ask the database for the user's job
            const { data: jobs, error: jobsError } = await supabaseClient
                .from('jobs')
                .select('*')
                .eq('user_id', currentUser.userId)
                .order('created_at', { ascending: true })
                .limit(1);

            if (jobsError) {
                return alert('Error loading your job: ' + jobsError.message);
            }

            userJob = getUserEmploymentInfo(jobs[0]);
            if (!userJob) {
                document.getElementById('job-title-display').textContent = 'No job info found';
                return;
            }
            selectedJobId = userJob.id;
            document.getElementById('job-title-display').textContent = userJob.job_title;

            // third we load everything that needs the job
            await renderComparison();
            await loadTodaysCommissions();
            await loadCommissionEntriesForDate(todayStr());
            await loadTodaysBreaks();
            await checkActiveShift();
            await refreshTotals(); // this now also sets the earnings box correctly on its own
            await renderMonthlyChart();
        }

        // there is only one job now, so this just hands back userJob
        // (kept so the code that calls it reads the same as before)
        function getSelectedJob() {
            return userJob;
        }

        // fetches today's commission entries and sums them per job_id, for use in the live effective-rate comparison
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

        // sums completed hours worked this week for a given job, up to (not including) a cutoff time —
        // used as the "baseline" so the live counter knows if it's already past the overtime threshold
        async function getWeeklyHoursBeforeShift(jobId, cutoffDate) {
            const weekStart = getWeekStartDate(cutoffDate);

            const { data, error } = await supabaseClient
                .from('shifts')
                .select('id, clock_in, clock_out')
                .eq('user_id', currentUser.userId)
                .eq('job_id', jobId)
                .not('clock_out', 'is', null)
                .gte('clock_in', weekStart.toISOString())
                .lt('clock_in', cutoffDate.toISOString());

            if (error || !data) return 0;

            // take the lunch breaks out the same way the totals do, so the live counter and the totals agree
            const breaksByShiftId = await fetchBreaksByShiftId(data.map(s => s.id));

            return data.reduce((sum, s) => {
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
            const clockedOutJob = getSelectedJob();
            activeShift = null;
            liveShiftWage = 0;
            document.getElementById('clock-in').disabled = false;
            document.getElementById('clock-out').disabled = true;
            document.getElementById('start-lunch-btn').disabled = true;
            setLunchButtonsState(false);
            document.getElementById('lunch-status').textContent = '';
            document.getElementById('clock-status').textContent = 'Not clocked in';
            document.getElementById('clock-status').classList.remove('active');
            if (clockedOutJob) {
                updateComparisonRow(clockedOutJob, parseFloat(clockedOutJob.hourly_wage), false);
            }
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

            activeBreak = data[0];
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

        async function startLiveTimer() {
            const job = getSelectedJob();
            const wage = job ? parseFloat(job.hourly_wage) : 0;
            const minuteWage = wage / 60; // pay rate per minute, the basis for the live tracker

            // minutes already worked this week (other completed shifts, same job) before this one started
            const minutesBeforeThisShift = job
                ? (await getWeeklyHoursBeforeShift(job.id, new Date(activeShift.clock_in))) * 60
                : 0;

            liveTimerInterval = setInterval(async () => {
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

                // live tracker = minute wage × minutes worked, with the overtime
                // bump applied to whichever minutes push the week past 40 hours
                // (2400 minutes) for this job
                const OVERTIME_WEEKLY_THRESHOLD_MINUTES = OVERTIME_WEEKLY_THRESHOLD * 60;
                const regularMinutes = Math.max(0, Math.min(elapsedMinutes, OVERTIME_WEEKLY_THRESHOLD_MINUTES - minutesBeforeThisShift));
                const overtimeMinutes = elapsedMinutes - regularMinutes;
                const wagePay = (regularMinutes * minuteWage) + (overtimeMinutes * minuteWage * OVERTIME_MULTIPLIER);

                liveShiftWage = wagePay; // lets the Day / Week / Month / Year totals follow the running shift
                renderTotals();

                const commissionSoFar = job ? (todaysCommissionByJob[String(job.id)] || 0) : 0;
                const pay = wagePay + commissionSoFar; // live tracker = minute wage (worked out) + commission

                const payDisplay = document.getElementById('live-pay');
                payDisplay.textContent = formatMoney(calculateTax(pay, 'constantpay'));
                payDisplay.classList.remove('tick');
                void payDisplay.offsetWidth; // restart animation
                payDisplay.classList.add('tick');

                if (job) {
                    const elapsedHoursForRate = elapsedMinutes / 60;
                    const effectiveRate = elapsedHoursForRate > 0.001 ? pay / elapsedHoursForRate : wage;
                    updateComparisonRow(job, effectiveRate, true);
                }
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
                .select('id, amount, job_id, jobs(job_title)')
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
            const jobTitle = entry.jobs ? entry.jobs.job_title : '(job removed)';
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
            const jobTitle = entry.jobs ? entry.jobs.job_title : '(job removed)';
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
                .select('*, jobs(hourly_wage)')
                .eq('user_id', currentUser.userId)
                .not('clock_out', 'is', null)
                .gte('clock_in', fetchFrom.toISOString())
                .lt('clock_in', endDate.toISOString());

            if (error || !shifts) return 0;

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

            renderTotals();

            // both the big number AND the breakdown line follow whichever date
            // is selected in the "Viewing:" picker — if that date is today AND
            // there's an active shift, the live timer keeps controlling the
            // number instead (handled inside this function)
            updateEarningsBox(refDate, dayWagePay, dayCommissionPay);
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

                document.getElementById('total-' + period).textContent = formatMoney(calculateTax(total, 'pay-section'));
            });
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

                const total = calculateTax(wagePay + commissionPay, 'constantpay');
                bigNumberEl.textContent = formatMoney(total);
            } else {
                // not today — hide the single combined number, show wage/commission
                // as two separate figures instead
                bigNumberEl.style.display = 'none';
                breakdownEl.classList.add('breakdown-primary');
                breakdownEl.innerHTML = `<span>Wages: ${formatMoney(calculateTax(wagePay, 'constantpay'))}</span><span>Commission: ${formatMoney(calculateTax(commissionPay, 'constantpay'))}</span>`;
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

        // ---------- TAX TOGGLES ----------
        document.querySelectorAll('.tax-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-target');
                showAfterTax[target] = !showAfterTax[target];
                btn.textContent = showAfterTax[target] ? 'Show Before Tax' : 'Show After Tax';

                if (target === 'income-monthly-graph') {
                    renderMonthlyChart();
                } else {
                    refreshTotals();
                }
            });
        });

        // ---------- WAGE COMPARISON ----------
        async function renderComparison() {
            const container = document.getElementById('comparison-list');
            container.innerHTML = '';

            // fetch reference wage data once and cache it (avoids re-querying every second)
            const { data: averages, error } = await supabaseClient
                .from('job_averages')
                .select('job_title, average_wage')
                .eq('job_title', userJob.job_title);

            if (error) {
                container.textContent = 'Could not load comparison data.';
                return;
            }

            avgLookupCache = {};
            (averages || []).forEach(a => {
                avgLookupCache[a.job_title.toLowerCase().trim()] = parseFloat(a.average_wage);
            });

            const row = document.createElement('div');
            row.className = 'comparison-row';
            row.id = 'comparison-row-' + userJob.id;
            container.appendChild(row);
            updateComparisonRow(userJob, parseFloat(userJob.hourly_wage), false);
        }

        // updates a single job's comparison row using whatever rate is passed in
        // (the static hourly wage normally, or a live effective rate while clocked in)
        function updateComparisonRow(job, rate, isLive) {
            const row = document.getElementById('comparison-row-' + job.id);
            if (!row) return;

            const key = job.job_title.toLowerCase().trim();
            const avg = avgLookupCache[key];

            if (avg === undefined) {
                row.textContent = job.job_title + ': no reference data available';
                return;
            }

            const diff = ((rate - avg) / avg) * 100;
            const diffText = diff >= 0
                ? `${diff.toFixed(1)}% above average`
                : `${Math.abs(diff).toFixed(1)}% below average`;
            const liveTag = isLive ? ' <span class="live-tag">● live</span>' : '';

            row.classList.remove('above', 'below');
            row.classList.add(diff >= 0 ? 'above' : 'below');

            row.innerHTML = `<strong>${job.job_title}</strong>: $${rate.toFixed(2)}/hr — ${diffText} (avg $${avg.toFixed(2)}/hr)${liveTag}`;
        }

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
                .select('id, job_id, clock_in, clock_out, jobs(hourly_wage)')
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

                wageData.push(calculateTax(wageTotal, 'income-monthly-graph'));
                commissionData.push(calculateTax(commissionTotal, 'income-monthly-graph'));
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
                            backgroundColor: '#0f766e',
                            borderRadius: 6,
                            stack: 'income'
                        },
                        {
                            label: 'Commission',
                            data: commissionData,
                            backgroundColor: '#f59e0b',
                            borderRadius: 6,
                            stack: 'income'
                        }
                    ]
                },
                options: {
                    responsive: true,
                    animation: { duration: 600, easing: 'easeOutQuart' },
                    scales: {
                        x: { stacked: true, grid: { display: false } },
                        y: {
                            stacked: true,
                            ticks: { callback: (val) => '$' + val }
                        }
                    },
                    plugins: {
                        legend: { position: 'bottom' },
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
        //   five_star_reviews / notes are stored in a new "daily_metrics"
        //   table — pure business metrics, NOT pay. They don't duplicate
        //   anything that already exists.
        // - The $5/repair + $35/signup commission this form calculates gets
        //   saved into the EXISTING "commissions" table (upserted per day),
        //   so it feeds the same totals as everywhere else in the app rather
        //   than being a disconnected number.
        // - "Hours Worked" on this form creates/updates a manual shift in the
        //   EXISTING "shifts" table (same mechanism as "Add a Shift" on the
        //   Shifts page), so it runs through the real overtime calculation
        //   instead of being a separate fake hours figure.

        const PHONE_REPAIR_RATE = 5;
        const INSURANCE_SIGNUP_RATE = 35;

        // ---------- INIT for this section ----------
        async function initWorkTracker() {
            document.getElementById('entry-date').value = todayStr();
            document.getElementById('spending-date').value = todayStr();

            const job = getSelectedJob();
            document.getElementById('entry-rate-hint').textContent = job
                ? `Hourly pay rate for ${job.job_title}: $${parseFloat(job.hourly_wage).toFixed(2)}/hr`
                : 'Add a job in User Info to see your hourly rate.';

            await loadDailyEntryForDate(todayStr());
            await loadDailySummaryForDate(todayStr());
            await loadSpendingForDate(todayStr());
            await loadWeeklySnapshot();
            await loadMonthCompare();
            await loadYearTotals();
            await loadSaveGoalPlanner();
            await renderTwelveMonthChart();
        }

        // ---------- DAILY ENTRY FORM (phones, signups, customers, reviews, notes) ----------

        // Pre-fills the form with whatever's already saved for a given date, if anything.
        async function loadDailyEntryForDate(dateStr) {
            if (!selectedJobId) return;

            const { data, error } = await supabaseClient
                .from('daily_metrics')
                .select('*')
                .eq('user_id', currentUser.userId)
                .eq('job_id', selectedJobId)
                .eq('entry_date', dateStr)
                .maybeSingle();

            if (error || !data) {
                document.getElementById('entry-phones').value = '';
                document.getElementById('entry-signups').value = '';
                document.getElementById('entry-customers').value = '';
                document.getElementById('entry-reviews').value = '';
                document.getElementById('entry-notes').value = '';
                return;
            }

            document.getElementById('entry-phones').value = data.phones_repaired || '';
            document.getElementById('entry-signups').value = data.insurance_signups || '';
            document.getElementById('entry-customers').value = data.total_customers || '';
            document.getElementById('entry-reviews').value = data.five_star_reviews || '';
            document.getElementById('entry-notes').value = data.notes || '';
        }

        document.getElementById('entry-date').addEventListener('change', async () => {
            const dateStr = document.getElementById('entry-date').value || todayStr();
            await loadDailyEntryForDate(dateStr);
            await loadDailySummaryForDate(dateStr);
        });

        document.getElementById('clear-entry-btn').addEventListener('click', () => {
            document.getElementById('entry-hours').value = '';
            document.getElementById('entry-phones').value = '';
            document.getElementById('entry-signups').value = '';
            document.getElementById('entry-customers').value = '';
            document.getElementById('entry-reviews').value = '';
            document.getElementById('entry-notes').value = '';
            document.getElementById('daily-entry-status').textContent = '';
        });

        document.getElementById('daily-entry-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const statusEl = document.getElementById('daily-entry-status');
            statusEl.textContent = '';

            if (!selectedJobId) {
                statusEl.textContent = 'Add a job in User Info before saving a daily entry.';
                return;
            }

            const dateStr = document.getElementById('entry-date').value;
            const hours = parseFloat(document.getElementById('entry-hours').value) || 0;
            const phones = parseInt(document.getElementById('entry-phones').value, 10) || 0;
            const signups = parseInt(document.getElementById('entry-signups').value, 10) || 0;
            const customers = parseInt(document.getElementById('entry-customers').value, 10) || 0;
            const reviews = parseInt(document.getElementById('entry-reviews').value, 10) || 0;
            const notes = document.getElementById('entry-notes').value.trim();

            switch (true) {
                case !dateStr:
                    statusEl.textContent = 'Please choose a date.';
                    return;
                case reviews > customers && customers > 0:
                    statusEl.textContent = '5-star reviews can\'t exceed total customers.';
                    return;
            }

            // 1) Upsert the business metrics (phones/signups/customers/reviews/notes)
            const { error: metricsError } = await supabaseClient
                .from('daily_metrics')
                .upsert([{
                    user_id: currentUser.userId,
                    job_id: selectedJobId,
                    entry_date: dateStr,
                    phones_repaired: phones,
                    insurance_signups: signups,
                    total_customers: customers,
                    five_star_reviews: reviews,
                    notes: notes || null,
                    updated_at: new Date().toISOString()
                }], { onConflict: 'user_id,job_id,entry_date' });

            if (metricsError) {
                statusEl.textContent = 'Error saving daily metrics: ' + metricsError.message;
                return;
            }

            // 2) Auto-calculate commission from phones + signups and save it into
            // the existing commissions table (replacing any prior commission this
            // form saved for the same day, so re-saving doesn't double it up)
            const commissionAmount = (phones * PHONE_REPAIR_RATE) + (signups * INSURANCE_SIGNUP_RATE);

            await supabaseClient
                .from('commissions')
                .delete()
                .eq('user_id', currentUser.userId)
                .eq('job_id', selectedJobId)
                .eq('entry_date', dateStr)
                .eq('from_daily_tracker', true);

            if (commissionAmount > 0) {
                await supabaseClient
                    .from('commissions')
                    .insert([{
                        user_id: currentUser.userId,
                        job_id: selectedJobId,
                        amount: commissionAmount,
                        entry_date: dateStr,
                        from_daily_tracker: true
                    }]);
            }

            // 3) If hours were entered, create a manual shift for that day
            // (same approach as "Add a Shift" on the Shifts page) — but only
            // if one doesn't already exist for this date, to avoid piling up
            // duplicate shifts every time the form is re-saved
            if (hours > 0) {
                const { data: existingShifts } = await supabaseClient
                    .from('shifts')
                    .select('id')
                    .eq('user_id', currentUser.userId)
                    .eq('job_id', selectedJobId)
                    .gte('clock_in', dateStr + 'T00:00:00')
                    .lt('clock_in', dateStr + 'T23:59:59')
                    .not('clock_out', 'is', null);

                if (!existingShifts || existingShifts.length === 0) {
                    const clockIn = new Date(dateStr + 'T09:00:00');
                    const clockOut = new Date(clockIn);
                    clockOut.setMinutes(clockOut.getMinutes() + Math.round(hours * 60));

                    await supabaseClient
                        .from('shifts')
                        .insert([{
                            user_id: currentUser.userId,
                            job_id: selectedJobId,
                            clock_in: clockIn.toISOString(),
                            clock_out: clockOut.toISOString()
                        }]);
                }
            }

            statusEl.textContent = 'Day saved!';
            statusEl.style.color = '#0f766e';

            await loadDailySummaryForDate(dateStr);
            await loadWeeklySnapshot();
            await loadMonthCompare();
            await loadYearTotals();
            await loadSaveGoalPlanner();
            await renderTwelveMonthChart();
            await refreshTotals();
        });

        // ---------- DAILY SUMMARY ----------
        async function loadDailySummaryForDate(dateStr) {
            const refDate = parseLocalDate(dateStr);
            const nextDay = new Date(refDate);
            nextDay.setDate(nextDay.getDate() + 1);

            const wagePay = await computeShiftsPay(refDate, nextDay);
            const commissionPay = await computeCommissions(refDate, nextDay);
            const total = wagePay + commissionPay;

            document.getElementById('summary-hourly-pay').textContent = formatMoney(wagePay);
            document.getElementById('summary-commission-pay').textContent = formatMoney(commissionPay);
            document.getElementById('summary-total-daily').textContent = formatMoney(total);

            // 5-star rate from daily_metrics for this date
            const { data } = await supabaseClient
                .from('daily_metrics')
                .select('total_customers, five_star_reviews')
                .eq('user_id', currentUser.userId)
                .eq('entry_date', dateStr)
                .maybeSingle();

            const rate = data && data.total_customers > 0
                ? (data.five_star_reviews / data.total_customers) * 100
                : 0;
            document.getElementById('summary-star-rate').textContent = rate.toFixed(2) + '%';
        }

        // ---------- WEEKLY SNAPSHOT ----------
        async function loadWeeklySnapshot() {
            const today = parseLocalDate(todayStr());
            const weekStart = getRangeStart('week', today);
            const tomorrow = getTomorrowStart();

            const wagePay = await computeShiftsPay(weekStart, tomorrow);
            const commissionPay = await computeCommissions(weekStart, tomorrow);
            document.getElementById('snapshot-week-earnings').textContent = formatMoney(wagePay + commissionPay);
        }

        // ---------- DAILY SPENDING ----------
        document.getElementById('spending-date').addEventListener('change', () => {
            loadSpendingForDate(document.getElementById('spending-date').value || todayStr());
        });

        document.getElementById('save-spending-btn').addEventListener('click', async () => {
            const statusEl = document.getElementById('spending-status');
            const dateStr = document.getElementById('spending-date').value || todayStr();
            const amount = parseFloat(document.getElementById('spending-amount').value);

            if (isNaN(amount) || amount <= 0) {
                statusEl.textContent = 'Enter a valid amount.';
                return;
            }

            const { error } = await supabaseClient
                .from('daily_spending')
                .insert([{ user_id: currentUser.userId, entry_date: dateStr, amount: amount }]);

            if (error) {
                statusEl.textContent = 'Error: ' + error.message;
                return;
            }

            statusEl.textContent = 'Spending saved!';
            statusEl.style.color = '#0f766e';
            document.getElementById('spending-amount').value = '';
            await loadSpendingForDate(dateStr);
        });

        async function loadSpendingForDate(dateStr) {
            const { data } = await supabaseClient
                .from('daily_spending')
                .select('amount')
                .eq('user_id', currentUser.userId)
                .eq('entry_date', dateStr);

            const total = (data || []).reduce((sum, s) => sum + parseFloat(s.amount), 0);
            document.getElementById('spending-selected-day').textContent = formatMoney(total);
        }

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

            const { data } = await supabaseClient
                .from('daily_metrics')
                .select('phones_repaired, five_star_reviews, total_customers')
                .eq('user_id', currentUser.userId)
                .gte('entry_date', start.toISOString().split('T')[0])
                .lt('entry_date', end.toISOString().split('T')[0]);

            const phones = (data || []).reduce((sum, d) => sum + (d.phones_repaired || 0), 0);
            const reviews = (data || []).reduce((sum, d) => sum + (d.five_star_reviews || 0), 0);
            const customers = (data || []).reduce((sum, d) => sum + (d.total_customers || 0), 0);
            const rate = customers > 0 ? (reviews / customers) * 100 : 0;

            document.getElementById(`compare-${prefix}-phones`).textContent = phones;
            document.getElementById(`compare-${prefix}-reviews`).textContent = reviews;
            document.getElementById(`compare-${prefix}-rate`).textContent = rate.toFixed(2) + '%';
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

        // ---------- LAST 12 MONTHS CHART (money + 5-star rate) ----------
        let twelveMonthChart = null;

        async function renderTwelveMonthChart() {
            const labels = [];
            const moneyData = [];
            const starRateData = [];

            for (let i = 11; i >= 0; i--) {
                const { start, end, label } = getMonthRange(i);
                labels.push(label);

                const wagePay = await computeShiftsPay(start, end);
                const commissionPay = await computeCommissions(start, end);
                moneyData.push(wagePay + commissionPay);

                const { data } = await supabaseClient
                    .from('daily_metrics')
                    .select('total_customers, five_star_reviews')
                    .eq('user_id', currentUser.userId)
                    .gte('entry_date', start.toISOString().split('T')[0])
                    .lt('entry_date', end.toISOString().split('T')[0]);

                const customers = (data || []).reduce((sum, d) => sum + (d.total_customers || 0), 0);
                const reviews = (data || []).reduce((sum, d) => sum + (d.five_star_reviews || 0), 0);
                starRateData.push(customers > 0 ? (reviews / customers) * 100 : 0);
            }

            const ctx = document.getElementById('twelve-month-chart');

            if (twelveMonthChart) {
                twelveMonthChart.data.labels = labels;
                twelveMonthChart.data.datasets[0].data = moneyData;
                twelveMonthChart.data.datasets[1].data = starRateData;
                twelveMonthChart.update();
                return;
            }

            twelveMonthChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            type: 'bar',
                            label: 'Money',
                            data: moneyData,
                            backgroundColor: '#0f766e',
                            yAxisID: 'y'
                        },
                        {
                            type: 'line',
                            label: '5-Star Rate (%)',
                            data: starRateData,
                            borderColor: '#f59e0b',
                            backgroundColor: '#f59e0b',
                            yAxisID: 'y1',
                            tension: 0.3
                        }
                    ]
                },
                options: {
                    responsive: true,
                    scales: {
                        y: { position: 'left', ticks: { callback: (val) => '$' + val } },
                        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: (val) => val + '%' } }
                    },
                    plugins: { legend: { position: 'bottom' } }
                }
            });
        }

        // initWorkTracker depends on selectedJobId being set by init() first,
        // so it must run after init() fully finishes, not in parallel with it.
        (async () => {
            await init();
            if (currentUser && userJob) {
                await initWorkTracker();
            }
        })();
