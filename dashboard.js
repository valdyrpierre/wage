        // ============================================================
        // WEEKLY SCHEDULE — the shifts the user is scheduled to work: week view, copy the week, estimate
        // ============================================================
        let scheduledShifts = [];     // the scheduled shifts around the week on screen (the month for the estimate too)
        let scheduleWeekStart = null; // the Sunday of the week on screen
        const MAX_COPY_WEEKS = 12;

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
            deleteButton.addEventListener('click', () => handleDeleteScheduledShift(shift.id));
            chip.appendChild(deleteButton);

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
            document.getElementById('sched-week-label').textContent = first + ' – ' + last;
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

        // First it checks the form, then it saves the shift, and last it shows it in the week.
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

            const error = await addScheduledShifts([{
                user_id: currentUser.userId,
                job_id: form.jobId,
                shift_date: form.date,
                start_time: form.start,
                end_time: form.end,
                break_minutes: form.breakMinutes
            }]);

            if (error) {
                statusEl.textContent = 'Error saving shift: ' + error.message;
                return;
            }

            // jump to the week of the new shift so the user sees it right away
            scheduleWeekStart = getWeekStartDate(parseLocalDate(form.date));
            await loadSchedule();
        });

        // ---------- DELETE ----------

        // Asks first, then deletes one scheduled shift.
        async function handleDeleteScheduledShift(shiftId)
        {
            if (!confirm('Delete this scheduled shift?')) return;

            const error = await deleteScheduledShift(shiftId);
            if (error) return alert('Error deleting shift: ' + error.message);

            await loadSchedule();
        }

        // Asks first, then deletes every scheduled shift of the week on screen.
        addListener('sched-clear-week', 'click', async () => {
            const weekShifts = scheduledShifts.filter(shift => shift.shift_date >= dateToStr(scheduleWeekStart) && shift.shift_date < dateToStr(addDays(scheduleWeekStart, 7)));
            if (weekShifts.length === 0) return alert('There are no scheduled shifts in this week.');

            if (!confirm(`Delete all ${weekShifts.length} scheduled shift(s) of this week?`)) return;

            const error = await deleteScheduledWeek(scheduleWeekStart);
            if (error) return alert('Error clearing the week: ' + error.message);

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
        addListener('sched-copy-btn', 'click', async () => {
            const weeksCount = parseInt(document.getElementById('sched-copy-weeks').value, 10);
            const weekStartStr = dateToStr(scheduleWeekStart);
            const weekEndStr = dateToStr(addDays(scheduleWeekStart, 7));
            const weekShifts = scheduledShifts.filter(shift => shift.shift_date >= weekStartStr && shift.shift_date < weekEndStr);

            switch (true) {
                case isNaN(weeksCount) || weeksCount < 1 || weeksCount > MAX_COPY_WEEKS:
                    return alert(`Choose between 1 and ${MAX_COPY_WEEKS} weeks.`);
                case weekShifts.length === 0:
                    return alert('This week has no scheduled shifts to copy. Add the shifts first.');
            }

            const rows = buildCopiedRows(weekShifts, weeksCount);

            // look at what is already scheduled in the weeks we are about to fill
            const existing = await obtainScheduledShifts(addDays(scheduleWeekStart, 7), addDays(scheduleWeekStart, 7 * (weeksCount + 1)));
            if (existing === null) return alert('Could not check the next weeks. Try again.');

            const existingKeys = new Set(existing.map(s => getShiftKey(s.job_id, s.shift_date, s.start_time, s.end_time)));
            const newRows = rows.filter(row => !existingKeys.has(getShiftKey(row.job_id, row.shift_date, row.start_time, row.end_time)));

            if (newRows.length === 0) return alert('Those weeks already have these shifts.');

            const error = await addScheduledShifts(newRows);
            if (error) return alert('Error copying the week: ' + error.message);

            scheduleWeekStart = addDays(scheduleWeekStart, 7);
            await loadSchedule();
        });

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
            await loadSchedule();
        }
