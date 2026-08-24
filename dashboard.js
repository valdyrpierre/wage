// TODO: replace with your actual Supabase project values
        const SUPABASE_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_4ProG0sjTH1-DCh9f5QsUg_L85xilyM';
        const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        let currentUser = null;
        let userJobs = [];
        let selectedJobId = null;
        let activeShift = null; // { id, job_id, clock_in }
        let activeBreak = null; // { id, break_start } — the currently-open lunch break, if any
        let liveTimerInterval = null;
        let showAfterTax = { "constantpay": false, "pay-section": false, "income-monthly-graph": false };
        let avgLookupCache = {};        // job_title(lowercase) -> average_wage, fetched once
        let todaysCommissionByJob = {}; // job_id -> total commission logged today
        let monthlyChart = null;        // Chart.js instance, kept so we can update instead of recreate
        const MONTHS_BACK = 6;          // how many months of history to show
        // NOTE: formatMoney, OVERTIME_WEEKLY_THRESHOLD, OVERTIME_MULTIPLIER,
        // getWeekStartDate, computeShiftPayWithOvertime, and fetchBreaksByShiftId
        // all now live in shared.js (loaded before this file) so every page
        // uses the exact same overtime/break logic.

        function todayStr() {
            const d = new Date();
            return d.toISOString().split('T')[0];
        }

        function getTaxRate() {
            const raw = parseFloat(document.getElementById('tax-rate').value) || 0;
            // clamp to a sane 0-100% range so a stray typo (like "150" or a
            // negative number) can't produce a nonsensical after-tax amount
            const clamped = Math.min(Math.max(raw, 0), 100);
            return clamped / 100;
        }

        function applyTax(amount, sectionKey) {
            if (showAfterTax[sectionKey]) {
                return amount * (1 - getTaxRate());
            }
            return amount;
        }

        // ---------- INIT ----------
        async function init() {
            document.getElementById('view-date').value = todayStr();

            const { data: { user }, error } = await supabaseClient.auth.getUser();
            if (error || !user) {
                window.location.href = 'login.html';
                return;
            }
            currentUser = user;
            document.getElementById('user-name').textContent = user.email;

            const { data: jobs, error: jobsError } = await supabaseClient
                .from('jobs')
                .select('*')
                .eq('user_id', user.id);

            if (jobsError || !jobs || jobs.length === 0) {
                document.getElementById('job-title-display').textContent = 'No job info found';
                userJobs = [];
            } else {
                userJobs = jobs;
                if (jobs.length === 1) {
                    document.getElementById('job-title-display').textContent = jobs[0].job_title;
                    selectedJobId = jobs[0].id;
                } else {
                    document.getElementById('job-title-display').textContent = jobs.length + ' jobs';
                    const jobSelectSection = document.getElementById('job-select-section');
                    const select = document.getElementById('active-job');
                    jobs.forEach(j => {
                        const opt = document.createElement('option');
                        opt.value = j.id;
                        opt.textContent = j.job_title + ' ($' + j.hourly_wage + '/hr)';
                        select.appendChild(opt);
                    });
                    jobSelectSection.style.display = 'block';
                    selectedJobId = jobs[0].id;
                    select.addEventListener('change', () => {
                        selectedJobId = select.value;
                    });
                }
            }

            await renderComparison();
            await loadTodaysCommissions();
            await checkActiveShift();
            await refreshTotals();
            await renderMonthlyChart();
        }

        function getSelectedJob() {
            return userJobs.find(j => String(j.id) === String(selectedJobId));
        }

        // fetches today's commission entries and sums them per job_id, for use in the live effective-rate comparison
        async function loadTodaysCommissions() {
            const { data, error } = await supabaseClient
                .from('commissions')
                .select('job_id, amount')
                .eq('user_id', currentUser.id)
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
                .select('clock_in, clock_out')
                .eq('user_id', currentUser.id)
                .eq('job_id', jobId)
                .not('clock_out', 'is', null)
                .gte('clock_in', weekStart.toISOString())
                .lt('clock_in', cutoffDate.toISOString());

            if (error || !data) return 0;

            return data.reduce((sum, s) => {
                const hours = (new Date(s.clock_out) - new Date(s.clock_in)) / (1000 * 60 * 60);
                return sum + hours;
            }, 0);
        }

        // ---------- CLOCK IN / OUT ----------
        async function checkActiveShift() {
            const { data, error } = await supabaseClient
                .from('shifts')
                .select('*')
                .eq('user_id', currentUser.id)
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
                .eq('user_id', currentUser.id)
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
                .insert([{ user_id: currentUser.id, job_id: selectedJobId, clock_in: clockInTime }])
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
            document.getElementById('clock-in').disabled = false;
            document.getElementById('clock-out').disabled = true;
            document.getElementById('start-lunch-btn').disabled = true;
            setLunchButtonsState(false);
            document.getElementById('lunch-status').textContent = '';
            document.getElementById('clock-status').textContent = 'Not clocked in';
            document.getElementById('clock-status').classList.remove('active');
            document.getElementById('live-pay').textContent = formatMoney(0);
            if (clockedOutJob) {
                updateComparisonRow(clockedOutJob, parseFloat(clockedOutJob.hourly_wage), false);
            }
            await refreshTotals();
        });

        // ---------- LUNCH BREAK ----------
        document.getElementById('start-lunch-btn').addEventListener('click', async () => {
            if (!activeShift || activeBreak) return;
            const btn = document.getElementById('start-lunch-btn');
            btn.disabled = true; // guard against double-click

            const { data, error } = await supabaseClient
                .from('breaks')
                .insert([{
                    user_id: currentUser.id,
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
            if (shouldRefresh) await refreshTotals();
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

            // hours already worked this week (other completed shifts, same job) before this one started
            const hoursBeforeThisShift = job
                ? await getWeeklyHoursBeforeShift(job.id, new Date(activeShift.clock_in))
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
                const rawElapsedHours = (now - clockInTime) / (1000 * 60 * 60);
                const elapsedHours = Math.max(0, rawElapsedHours - (breakMs / (1000 * 60 * 60))); // lunch time doesn't count toward pay

                const regularHours = Math.max(0, Math.min(elapsedHours, OVERTIME_WEEKLY_THRESHOLD - hoursBeforeThisShift));
                const overtimeHours = elapsedHours - regularHours;
                const pay = (regularHours * wage) + (overtimeHours * wage * OVERTIME_MULTIPLIER);

                const payDisplay = document.getElementById('live-pay');
                payDisplay.textContent = formatMoney(applyTax(pay, 'constantpay'));
                payDisplay.classList.remove('tick');
                void payDisplay.offsetWidth; // restart animation
                payDisplay.classList.add('tick');

                if (job) {
                    const commissionSoFar = todaysCommissionByJob[String(job.id)] || 0;
                    const effectiveRate = elapsedHours > 0.001 ? (pay + commissionSoFar) / elapsedHours : wage;
                    updateComparisonRow(job, effectiveRate, true);
                }
            }, 1000);
        }

        // ---------- COMMISSION ----------
        document.getElementById('add-commission-btn').addEventListener('click', async () => {
            const input = document.getElementById('commission-input');
            const amount = parseFloat(input.value);
            const statusEl = document.getElementById('commission-status');
            const MAX_REASONABLE_COMMISSION = 100000;

            if (!selectedJobId) {
                statusEl.textContent = 'Add a job in User Info before logging commission.';
                statusEl.style.color = '#dc2626';
                return;
            }

            if (isNaN(amount) || amount <= 0) {
                statusEl.textContent = 'Enter a valid commission amount.';
                statusEl.style.color = '#dc2626';
                return;
            }

            if (amount > MAX_REASONABLE_COMMISSION) {
                statusEl.textContent = `That amount seems too high — please double-check it.`;
                statusEl.style.color = '#dc2626';
                return;
            }

            const { error } = await supabaseClient
                .from('commissions')
                .insert([{
                    user_id: currentUser.id,
                    job_id: selectedJobId,
                    amount: amount,
                    entry_date: document.getElementById('view-date').value || todayStr()
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
            await refreshTotals();
        });

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

        async function computeShiftsPay(startDate, endDate) {
            // fetch from the start of the week containing startDate, so weekly overtime
            // accumulation is calculated correctly even if the period starts mid-week
            const fetchFrom = getWeekStartDate(startDate);

            const { data: shifts, error } = await supabaseClient
                .from('shifts')
                .select('*, jobs(hourly_wage)')
                .eq('user_id', currentUser.id)
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
                .eq('user_id', currentUser.id)
                .gte('entry_date', startDate.toISOString().split('T')[0])
                .lt('entry_date', endDate.toISOString().split('T')[0]);

            if (error || !commissions) return 0;
            return commissions.reduce((sum, c) => sum + parseFloat(c.amount), 0);
        }

        async function refreshTotals() {
            const refDate = new Date(document.getElementById('view-date').value || todayStr());
            const now = new Date(refDate);
            now.setDate(now.getDate() + 1); // end-exclusive for "day"

            const periods = ['day', 'week', 'month', 'year'];
            for (const period of periods) {
                const start = getRangeStart(period, refDate);
                const end = period === 'day' ? now : new Date(); // week/month/year run through "now" relative to today
                const endBound = period === 'day' ? now : new Date(Math.max(end, now));

                const shiftsPay = await computeShiftsPay(start, period === 'day' ? now : new Date(refDate.getFullYear() + 1, 0, 1));
                const commissionPay = await computeCommissions(start, period === 'day' ? now : new Date(refDate.getFullYear() + 1, 0, 1));
                const total = applyTax(shiftsPay + commissionPay, 'pay-section');

                document.getElementById('total-' + period).textContent = formatMoney(total);
            }
        }

        document.getElementById('view-date').addEventListener('change', refreshTotals);
        document.getElementById('tax-rate').addEventListener('input', refreshTotals);

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

            if (userJobs.length === 0) {
                container.textContent = 'Add a job in User Info to see a comparison.';
                return;
            }

            // fetch reference wage data once and cache it (avoids re-querying every second)
            const titles = userJobs.map(j => j.job_title);
            const { data: averages, error } = await supabaseClient
                .from('job_averages')
                .select('job_title, average_wage')
                .in('job_title', titles);

            if (error) {
                container.textContent = 'Could not load comparison data.';
                return;
            }

            avgLookupCache = {};
            (averages || []).forEach(a => {
                avgLookupCache[a.job_title.toLowerCase().trim()] = parseFloat(a.average_wage);
            });

            userJobs.forEach(job => {
                const row = document.createElement('div');
                row.className = 'comparison-row';
                row.id = 'comparison-row-' + job.id;
                container.appendChild(row);
                updateComparisonRow(job, parseFloat(job.hourly_wage), false);
            });
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
                .eq('user_id', currentUser.id)
                .not('clock_out', 'is', null)
                .gte('clock_in', earliest.toISOString());

            const { data: commissions } = await supabaseClient
                .from('commissions')
                .select('amount, entry_date')
                .eq('user_id', currentUser.id)
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
                    const entryDate = new Date(c.entry_date);
                    if (entryDate >= start && entryDate < end) {
                        commissionTotal += parseFloat(c.amount);
                    }
                });

                wageData.push(applyTax(wageTotal, 'income-monthly-graph'));
                commissionData.push(applyTax(commissionTotal, 'income-monthly-graph'));
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

        init();