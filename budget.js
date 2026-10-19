const SUPABASE_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_4ProG0sjTH1-DCh9f5QsUg_L85xilyM';
        const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        let currentUser = null;
        let allBills = [];
        let selectedMonthKey = null; // the month shown in Bills by Month, like "2026-10" (null = this month)
        const MAX_REASONABLE_AMOUNT = 1000000;
        const SPLIT_GAP_DAYS = 14;
        const DUE_SOON_DAYS = 5;

        // NOTE: formatMoney, getWeekStartDate, computeShiftPayWithOvertime and
        // fetchBreaksByShiftId live in shared.js (loaded before this file), so the
        // "Earned This Month" number here always agrees with the dashboard.

        // Converts between a "YYYY-MM-DD" string and a LOCAL Date, in both directions:
        // - give it a string and it returns the Date (new Date('2026-10-23') would be read as UTC,
        //   so in Massachusetts it would show up as Oct 22)
        // - give it a Date and it returns the string (toISOString would give tomorrow's date
        //   after about 8pm Eastern)
        function localDate(value)
        {
            if (typeof value === 'string') {
                const [year, month, day] = value.split('-').map(Number);
                return new Date(year, month - 1, day);
            }
            return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
        }

        // Whole number of calendar days between two dates (dateA - dateB).
        // Both dates are cut down to midnight first so the time of day and the
        // daylight saving change can never move the answer by one day.
        function daysBetween(dateA, dateB)
        {
            const msPerDay = 1000 * 60 * 60 * 24;
            const dayA = Date.UTC(dateA.getFullYear(), dateA.getMonth(), dateA.getDate());
            const dayB = Date.UTC(dateB.getFullYear(), dateB.getMonth(), dateB.getDate());
            return Math.round((dayA - dayB) / msPerDay);
        }

        // True when a "YYYY-MM-DD" string falls in the same month and year as refDate.
        function isSameMonth(dateStr, refDate)
        {
            const d = localDate(dateStr);
            return d.getFullYear() === refDate.getFullYear() && d.getMonth() === refDate.getMonth();
        }

        // Returns the date that is N months after dateStr, on the same day of the month.
        // If that month is shorter, it is clamped to the last day (Jan 31 + 1 month = Feb 28).
        function addMonthsClamped(dateStr, monthsToAdd)
        {
            const original = localDate(dateStr);
            const targetMonthIndex = original.getMonth() + monthsToAdd;

            // day 0 of the next month is the last day of the target month
            const lastDayOfTargetMonth = new Date(original.getFullYear(), targetMonthIndex + 1, 0).getDate();
            const clampedDay = Math.min(original.getDate(), lastDayOfTargetMonth);

            return new Date(original.getFullYear(), targetMonthIndex, clampedDay);
        }

        // Returns the first day of this month and the first day of next month.
        function getThisMonthRange()
        {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), 1);
            const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            return { start, end };
        }

        // ============================================================
        // USER + DATA (every obtain function returns the data, or null if it could not get it)
        // ============================================================

        // Checks who is logged in. If nobody is, it sends them to the login page.
        // If a user is logged in, it fills the page with the info about the user:
        // - income
        // - bills
        async function obtainCurrentUser()
        {
            const { data: { user }, error } = await supabaseClient.auth.getUser();
            if (error || !user) {
                window.location.href = 'login.html';
                return false;
            }
            currentUser = { email: user.email, userId: user.id };
            return fillUserInfo();
        }

        // Gets every finished shift that could count for this month. It starts from the Sunday
        // of the week the month begins in, because those earlier shifts are needed to know if a
        // later shift of the same week went over the 40 hour overtime limit.
        async function obtainUserShifts(monthStart, monthEnd)
        {
            switch (true) {
                case currentUser === null:
                    console.error('No user is logged in.');
                    return null;
            }

            const { data, error } = await supabaseClient
                .from('shifts')
                .select('id, job_id, clock_in, clock_out, jobs(hourly_wage, company)')
                .eq('user_id', currentUser.userId)
                .not('clock_out', 'is', null)
                .gte('clock_in', getWeekStartDate(monthStart).toISOString())
                .lt('clock_in', monthEnd.toISOString());

            // if we load a user but not the shifts let dev know
            if (error) {
                console.error('User is logged in but shifts are not loaded:', error);
                return null;
            }
            return data || [];
        }

        // Adds up the pay of ONLY the shifts that clocked in during the month. The extra shifts
        // from before the month were fetched just for the overtime math, so they are skipped here.
        function sumWagesInMonth(shifts, shiftPayMap, monthStart, monthEnd)
        {
            let wageTotal = 0;

            shifts.forEach(shift => {
                const clockIn = new Date(shift.clock_in);
                if (clockIn >= monthStart && clockIn < monthEnd) {
                    wageTotal += shiftPayMap.get(shift) || 0;
                }
            });

            return wageTotal;
        }

        // this will load the wages the user earned this month (overtime and unpaid lunch included)
        async function obtainUserIncome(monthStart, monthEnd)
        {
            const shifts = await obtainUserShifts(monthStart, monthEnd);
            if (shifts === null) return null;

            const breaksByShiftId = await fetchBreaksByShiftId(shifts.map(s => s.id));
            const shiftPayMap = computeShiftPayWithOvertime(shifts, breaksByShiftId);

            return sumWagesInMonth(shifts, shiftPayMap, monthStart, monthEnd);
        }

        // this will load user income earned from commission for this month
        async function obtainUserCommission(monthStart, monthEnd)
        {
            switch (true) {
                case currentUser === null:
                    console.error('No user is logged in.');
                    return null;
            }

            const { data, error } = await supabaseClient
                .from('commissions')
                .select('amount')
                .eq('user_id', currentUser.userId)
                .gte('entry_date', localDate(monthStart))
                .lt('entry_date', localDate(monthEnd));

            if (error) {
                console.error('User is logged in but commission is not loaded:', error);
                return null;
            }
            return (data || []).reduce((sum, c) => sum + parseFloat(c.amount), 0);
        }

        // this will load every bill of the user (soonest due first) and keep them in allBills
        async function obtainUserBills()
        {
            switch (true) {
                case currentUser === null:
                    console.error('No user is logged in.');
                    return null;
            }

            const { data, error } = await supabaseClient
                .from('bills')
                .select('*')
                .eq('user_id', currentUser.userId)
                .order('due_date', { ascending: true });

            if (error) {
                console.error('User is logged in but bills are not loaded:', error);
                return null;
            }

            allBills = data || [];
            return allBills;
        }

        // this function is responsible for calling
        // the function that gets the user's full monthly income (wages + commission)
        // the function that gets the user's bills
        // and then it draws every section of the page
        async function fillUserInfo()
        {
            const { start, end } = getThisMonthRange();

            const bills = await obtainUserBills();
            const wageTotal = await obtainUserIncome(start, end);
            const commissionTotal = await obtainUserCommission(start, end);

            if (bills === null) {
                document.getElementById('bill-schedules-list').textContent = 'Could not load bills.';
            } else {
                renderSchedules();
            }

            // the income is only shown when BOTH numbers loaded, so the summary never shows a wrong total
            if (wageTotal === null || commissionTotal === null) {
                renderIncomeError();
                renderSummary(null);
                return true;
            }

            renderIncome(wageTotal, commissionTotal);
            renderSummary(wageTotal + commissionTotal);
            return true;
        }

        // ============================================================
        // ADD / DELETE / UPDATE BILLS (each one only talks to the database, then refreshes the page)
        // ============================================================

        // this section allows the user to add bills (one row, or several rows for a split or recurring bill)
        async function addBill(bills)
        {
            const { error } = await supabaseClient
                .from('bills')
                .insert(bills);

            return error;
        }

        // this section allows the user to delete a bill
        async function deleteBill(billId)
        {
            const { error } = await supabaseClient
                .from('bills')
                .delete()
                .eq('id', billId)
                .eq('user_id', currentUser.userId);

            return error;
        }

        // deletes a bill and every later bill of the same monthly series
        async function deleteBillSeries(bill)
        {
            const { error } = await supabaseClient
                .from('bills')
                .delete()
                .eq('recurring_group', bill.recurring_group)
                .eq('user_id', currentUser.userId)
                .gte('due_date', bill.due_date);

            return error;
        }

        // this section allows the user to update a bill
        async function updateBill(billId, updatedBill)
        {
            const { error } = await supabaseClient
                .from('bills')
                .update(updatedBill)
                .eq('id', billId)
                .eq('user_id', currentUser.userId);

            return error;
        }

        // ============================================================
        // INCOME + SUMMARY
        // ============================================================

        // Puts the wage and commission numbers in the "My Income" box.
        function renderIncome(wageTotal, commissionTotal)
        {
            document.getElementById('summary-income').textContent = formatMoney(wageTotal + commissionTotal);
            document.getElementById('income-list').textContent =
                `Wages: ${formatMoney(wageTotal)}  •  Commission: ${formatMoney(commissionTotal)}`;
        }

        // Shows a message in the "My Income" box when the income could not be loaded.
        function renderIncomeError()
        {
            document.getElementById('summary-income').textContent = '—';
            document.getElementById('income-list').textContent = 'Could not load your income. Press F12 to see why.';
        }

        // Total of the bills that are due this month. A bill due next month should not
        // count against this month's income.
        function getTotalBillsThisMonth()
        {
            const now = new Date();
            return allBills
                .filter(bill => isSameMonth(bill.due_date, now))
                .reduce((sum, bill) => sum + parseFloat(bill.amount), 0);
        }

        // Percent of this month's bills that the income covers (0 when there are no bills).
        function calculatePercentCovered(income, totalBills)
        {
            if (totalBills <= 0) return 0;
            return (income / totalBills) * 100;
        }

        // Fills the Budget Summary boxes and the progress bar. income is null when it
        // could not be loaded, in that case only the bills total is shown.
        function renderSummary(income)
        {
            const totalBills = getTotalBillsThisMonth();
            document.getElementById('summary-bills').textContent = formatMoney(totalBills);

            if (income === null) {
                document.getElementById('summary-percent').textContent = '—';
                document.getElementById('summary-left').textContent = '—';
                return;
            }

            const percentCovered = calculatePercentCovered(income, totalBills);
            const leftToSpend = income - totalBills; // negative when the bills are more than the income

            document.getElementById('summary-percent').textContent = percentCovered.toFixed(0) + '%';
            document.getElementById('summary-left').textContent = formatMoney(leftToSpend);

            // the bar cannot go past full, but the number above it can show more than 100%
            const fill = document.getElementById('summary-progress-fill');
            fill.style.width = Math.min(percentCovered, 100) + '%';
            fill.classList.toggle('over', leftToSpend < 0);
        }

        // ============================================================
        // BILLS BY MONTH
        // ============================================================

        // Returns the extra text after a bill name: "Part 2 of 3", "Repeats monthly", or nothing.
        function getBillTag(bill)
        {
            if (bill.split_label) return bill.split_label;
            if (bill.is_recurring) return 'Repeats monthly';
            return '';
        }

        // Works out how urgent a bill is. Returns the css class for the row and the status text.
        function getBillStatus(bill)
        {
            const daysUntil = daysBetween(localDate(bill.due_date), new Date());

            switch (true) {
                case bill.paid:
                    return { cssClass: 'paid', text: 'Paid' };
                case daysUntil < 0:
                    return { cssClass: 'overdue', text: Math.abs(daysUntil) + ' day(s) overdue' };
                case daysUntil === 0:
                    return { cssClass: 'due-soon', text: 'Due today' };
                case daysUntil <= DUE_SOON_DAYS:
                    return { cssClass: 'due-soon', text: 'Due in ' + daysUntil + ' day(s)' };
                default:
                    return { cssClass: '', text: 'Due in ' + daysUntil + ' day(s)' };
            }
        }

        // Builds one small element with the given tag, class and text. (textContent, not innerHTML,
        // so a bill name with symbols in it can never break the page.)
        function buildElement(tagName, className, text)
        {
            const element = document.createElement(tagName);
            element.className = className;
            element.textContent = text;
            return element;
        }

        // Builds one button of a bill row (Edit or Delete).
        function buildRowButton(className, text, onClick)
        {
            const button = buildElement('button', className, text);
            button.type = 'button';
            button.addEventListener('click', onClick);
            return button;
        }

        // Builds the paid checkbox of a bill row. Ticking it saves right away.
        function buildPaidCheckbox(bill)
        {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'bill-check';
            checkbox.checked = bill.paid;
            checkbox.title = 'Mark as paid';
            checkbox.addEventListener('change', () => handleTogglePaid(bill.id, checkbox.checked));
            return checkbox;
        }

        // Builds the name of a bill, with its small tag (Part 2 of 3 / Repeats monthly) under it.
        function buildBillTitle(bill)
        {
            const title = buildElement('span', 'bill-title', '');
            title.appendChild(buildElement('span', 'bill-name', bill.name));

            const tag = getBillTag(bill);
            if (tag) title.appendChild(buildElement('span', 'bill-tag', tag));

            return title;
        }

        // Builds the little box that holds the Edit and Delete buttons of a row.
        function buildRowActions(bill)
        {
            const actions = buildElement('span', 'bill-actions', '');
            actions.appendChild(buildRowButton('edit-bill-btn', 'Edit', () => handleEditBill(bill.id)));
            actions.appendChild(buildRowButton('delete-bill-btn', 'Delete', () => handleDeleteBill(bill.id)));
            return actions;
        }

        // Builds one full bill row: checkbox, name, due date, amount, status pill, buttons.
        function buildBillRow(bill)
        {
            const status = getBillStatus(bill);

            const row = buildElement('div', 'bill-row', '');
            if (status.cssClass) row.classList.add(status.cssClass);

            row.appendChild(buildPaidCheckbox(bill));
            row.appendChild(buildBillTitle(bill));
            row.appendChild(buildElement('span', 'bill-due', localDate(bill.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
            row.appendChild(buildElement('span', 'bill-amount', formatMoney(parseFloat(bill.amount))));
            row.appendChild(buildElement('span', 'bill-status ' + status.cssClass, status.text));
            row.appendChild(buildRowActions(bill));

            return row;
        }

        // The key of the month we are in right now, like "2026-10".
        function getCurrentMonthKey()
        {
            return localDate(new Date()).slice(0, 7);
        }

        // The month that is on screen: the one the user picked, or this month if nothing was picked.
        function getSelectedMonthKey()
        {
            return selectedMonthKey || getCurrentMonthKey();
        }

        // Every month the picker can show: the months that have bills, plus this month. In order.
        function getMonthKeys()
        {
            const keys = new Set(allBills.map(bill => bill.due_date.slice(0, 7)));
            keys.add(getCurrentMonthKey());
            return [...keys].sort();
        }

        // "2026-10" -> "October 2026"
        function getMonthLabel(monthKey)
        {
            return localDate(monthKey + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        }

        // Only the bills that are due in the given month.
        function getBillsForMonth(monthKey)
        {
            return allBills.filter(bill => bill.due_date.slice(0, 7) === monthKey);
        }

        // Totals of one month: how many bills, how much, and how much of it is already paid.
        function summarizeMonth(bills)
        {
            const total = bills.reduce((sum, b) => sum + parseFloat(b.amount), 0);
            const paidBills = bills.filter(b => b.paid);
            const paidTotal = paidBills.reduce((sum, b) => sum + parseFloat(b.amount), 0);
            return { count: bills.length, paidCount: paidBills.length, total, paidTotal };
        }

        // Changes the month on screen and redraws the bills.
        function selectMonth(monthKey)
        {
            selectedMonthKey = monthKey;
            renderSchedules();
        }

        // Builds one of the small buttons of the month picker (previous, next, this month).
        function buildPickerButton(text, isDisabled, onClick)
        {
            const button = buildRowButton('picker-btn', text, onClick);
            button.disabled = isDisabled;
            return button;
        }

        // Builds the dropdown with every month that has bills.
        function buildMonthSelect(monthKeys, currentKey)
        {
            const select = document.createElement('select');
            select.className = 'picker-select';

            monthKeys.forEach(key => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = getMonthLabel(key);
                option.selected = key === currentKey;
                select.appendChild(option);
            });

            select.addEventListener('change', () => selectMonth(select.value));
            return select;
        }

        // Builds the month picker: [<] [month dropdown] [>] [This month]
        function buildMonthPicker()
        {
            const monthKeys = getMonthKeys();
            const currentKey = getSelectedMonthKey();
            const index = monthKeys.indexOf(currentKey);

            const picker = buildElement('div', 'month-picker', '');
            picker.appendChild(buildPickerButton('‹', index <= 0, () => selectMonth(monthKeys[index - 1])));
            picker.appendChild(buildMonthSelect(monthKeys, currentKey));
            picker.appendChild(buildPickerButton('›', index >= monthKeys.length - 1, () => selectMonth(monthKeys[index + 1])));
            picker.appendChild(buildPickerButton('This month', currentKey === getCurrentMonthKey(), () => selectMonth(null)));
            return picker;
        }

        // Builds the top of the month card: the month name, the total, the bills paid and a progress bar.
        function buildMonthHeader(monthKey, bills)
        {
            const summary = summarizeMonth(bills);
            const percentPaid = summary.total > 0 ? (summary.paidTotal / summary.total) * 100 : 0;

            const header = buildElement('div', 'month-header', '');

            const top = buildElement('span', 'month-top', '');
            top.appendChild(buildElement('span', 'month-name', getMonthLabel(monthKey)));
            top.appendChild(buildElement('span', 'month-total', formatMoney(summary.total)));
            header.appendChild(top);

            header.appendChild(buildElement('span', 'month-meta', `${summary.paidCount} of ${summary.count} paid  •  ${formatMoney(summary.total - summary.paidTotal)} left to pay`));

            const track = buildElement('span', 'month-track', '');
            const fill = buildElement('span', 'month-fill', '');
            fill.style.width = percentPaid + '%';
            track.appendChild(fill);
            header.appendChild(track);

            return header;
        }

        // Builds the card of the month on screen: the header, then one row per bill.
        function buildMonthCard(monthKey)
        {
            const bills = getBillsForMonth(monthKey);

            const card = buildElement('div', 'month-card', '');
            card.appendChild(buildMonthHeader(monthKey, bills));

            const list = buildElement('div', 'month-bills', '');
            if (bills.length === 0) list.appendChild(buildElement('p', 'month-empty', 'No bills this month.'));
            bills.forEach(bill => list.appendChild(buildBillRow(bill)));
            card.appendChild(list);

            return card;
        }

        // Draws the Bills by Month section: the picker, then the card of ONE month
        // (this month, until the user picks a different one).
        function renderSchedules()
        {
            const container = document.getElementById('bill-schedules-list');
            container.innerHTML = '';

            container.appendChild(buildMonthPicker());
            container.appendChild(buildMonthCard(getSelectedMonthKey()));
        }

        // ============================================================
        // BUTTON HANDLERS (ask the user, call the database function, refresh the page)
        // ============================================================

        // Saves the paid / unpaid change of one bill, then refreshes the page.
        async function handleTogglePaid(billId, paidValue)
        {
            const error = await updateBill(billId, { paid: paidValue });
            if (error) return alert('Could not update bill: ' + error.message);

            await fillUserInfo();
        }

        // First it confirms, then, if the bill repeats every month, it asks if the whole
        // series should go too. At the end it deletes and refreshes the page.
        async function handleDeleteBill(billId)
        {
            const bill = allBills.find(b => String(b.id) === String(billId));
            if (!bill) return;

            if (!confirm(`Delete "${bill.name}"?`)) return;

            let deleteWholeSeries = false;
            if (bill.is_recurring && bill.recurring_group) {
                deleteWholeSeries = confirm('This bill repeats monthly. Click OK to delete this AND all future occurrences in the series, or Cancel to delete just this one.');
            }

            const error = deleteWholeSeries ? await deleteBillSeries(bill) : await deleteBill(billId);
            if (error) return alert('Error deleting bill: ' + error.message);

            await fillUserInfo();
        }

        // Asks for the new name, amount and due date (the old values are filled in, so pressing
        // Cancel on any question stops the edit). It checks them the same way as the Add form,
        // then saves and refreshes the page.
        async function handleEditBill(billId)
        {
            const bill = allBills.find(b => String(b.id) === String(billId));
            if (!bill) return;

            const name = prompt('Bill name:', bill.name);
            if (name === null) return;
            const amount = prompt('Amount ($):', bill.amount);
            if (amount === null) return;
            const dueDate = prompt('Due date (YYYY-MM-DD):', bill.due_date);
            if (dueDate === null) return;

            const updated = { name: name.trim(), amount: parseFloat(amount), dueDate: dueDate.trim(), isRecurring: false };

            const problem = validateBillForm(updated) || validateDateText(updated.dueDate);
            if (problem) return alert(problem);

            const error = await updateBill(billId, { name: updated.name, amount: updated.amount, due_date: updated.dueDate });
            if (error) return alert('Error updating bill: ' + error.message);

            await fillUserInfo();
        }

        // ============================================================
        // ADD BILL FORM
        // ============================================================

        // Reads every input of the Add a Bill form into one object.
        function readBillForm()
        {
            return {
                name: document.getElementById('bill-name').value.trim(),
                amount: parseFloat(document.getElementById('bill-amount').value),
                dueDate: document.getElementById('bill-due-date').value,
                splitCount: parseInt(document.getElementById('bill-split').value, 10),
                isRecurring: document.getElementById('bill-recurring').checked,
                recurringMonths: parseInt(document.getElementById('bill-recurring-months').value, 10)
            };
        }

        // Checks the form. Returns the error message for the first problem it finds,
        // or an empty string when everything is fine.
        function validateBillForm(form)
        {
            switch (true) {
                case !form.name:
                    return 'Please enter a bill name.';
                case isNaN(form.amount) || form.amount <= 0:
                    return 'Amount must be a number greater than 0.';
                case form.amount > MAX_REASONABLE_AMOUNT:
                    return 'That amount seems too high — please double-check it.';
                case !form.dueDate:
                    return 'Please choose a due date.';
                case form.isRecurring && (isNaN(form.recurringMonths) || form.recurringMonths < 1 || form.recurringMonths > 24):
                    return 'Recurring months must be between 1 and 24.';
                default:
                    return '';
            }
        }

        // Checks that typed date text (used by the Edit question) is a real "YYYY-MM-DD" date.
        function validateDateText(dateStr)
        {
            const looksRight = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
            const isRealDate = looksRight && localDate(localDate(dateStr)) === dateStr;
            return isRealDate ? '' : 'Please type the date like 2026-10-23.';
        }

        // Builds the base row of a bill. The split and recurring options are added on top of it.
        function buildBillData(form, dueDate)
        {
            return {
                user_id: currentUser.userId,
                name: form.name,
                amount: form.amount,
                due_date: dueDate,
                paid: false,
                split_group: null,
                split_label: null,
                is_recurring: false,
                recurring_group: null
            };
        }

        // One row, exactly as entered.
        function buildSingleRows(form)
        {
            return [buildBillData(form, form.dueDate)];
        }

        // One row per month, all with the same recurring_group so they are known as one series.
        // Every month uses the full amount (it is not divided like a split).
        function buildRecurringRows(form)
        {
            const recurringGroup = crypto.randomUUID();
            const rows = [];

            for (let i = 0; i < form.recurringMonths; i++) {
                const row = buildBillData(form, localDate(addMonthsClamped(form.dueDate, i)));
                row.is_recurring = true;
                row.recurring_group = recurringGroup;
                rows.push(row);
            }
            return rows;
        }

        // One row per installment, all with the same split_group, spaced 2 weeks apart.
        // The amount is divided by the number of payments and rounded to the cent.
        function buildSplitRows(form)
        {
            const splitGroup = crypto.randomUUID();
            const splitAmount = Math.round((form.amount / form.splitCount) * 100) / 100;
            const baseDate = localDate(form.dueDate);
            const rows = [];

            for (let i = 0; i < form.splitCount; i++) {
                const installmentDate = new Date(baseDate);
                installmentDate.setDate(installmentDate.getDate() + (i * SPLIT_GAP_DAYS));

                const row = buildBillData(form, localDate(installmentDate));
                row.amount = splitAmount;
                row.split_group = splitGroup;
                row.split_label = `Part ${i + 1} of ${form.splitCount}`;
                rows.push(row);
            }
            return rows;
        }

        // Picks which kind of rows to build: recurring, split, or a single bill.
        function buildRowsToInsert(form)
        {
            switch (true) {
                case form.isRecurring:
                    return buildRecurringRows(form);
                case form.splitCount > 1:
                    return buildSplitRows(form);
                default:
                    return buildSingleRows(form);
            }
        }

        // Clears the form after a bill was added and hides the recurring options again.
        function resetBillForm()
        {
            document.getElementById('add-bill-form').reset();
            document.getElementById('recurring-months-wrap').style.display = 'none';
            document.getElementById('bill-split').disabled = false;
            document.getElementById('bill-recurring').disabled = false;
        }

        // ============================================================
        // PAGE EVENTS
        // ============================================================

        // Splitting and repeating monthly cannot be used together, so ticking "Repeat monthly"
        // turns the split dropdown off, and choosing a split turns the checkbox off.
        document.getElementById('bill-recurring').addEventListener('change', () => {
            const isChecked = document.getElementById('bill-recurring').checked;
            document.getElementById('recurring-months-wrap').style.display = isChecked ? 'block' : 'none';
            document.getElementById('bill-split').disabled = isChecked;
            if (isChecked) document.getElementById('bill-split').value = '1';
        });

        document.getElementById('bill-split').addEventListener('change', () => {
            const isSplitting = document.getElementById('bill-split').value !== '1';
            document.getElementById('bill-recurring').disabled = isSplitting;
            if (isSplitting) {
                document.getElementById('bill-recurring').checked = false;
                document.getElementById('recurring-months-wrap').style.display = 'none';
            }
        });

        // First it reads and checks the form, then it builds the rows, saves them all in one
        // request and refreshes the page so the new bill shows up right away.
        document.getElementById('add-bill-form').addEventListener('submit', async (e) => {
            e.preventDefault();

            const statusEl = document.getElementById('bill-form-status');
            statusEl.textContent = '';

            const form = readBillForm();
            const problem = validateBillForm(form);
            if (problem) {
                statusEl.textContent = problem;
                return;
            }

            const error = await addBill(buildRowsToInsert(form));
            if (error) {
                statusEl.textContent = 'Error adding bill: ' + error.message;
                return;
            }

            resetBillForm();
            await fillUserInfo();
        });

        document.getElementById('nav-logout-btn').addEventListener('click', async () => {
            await supabaseClient.auth.signOut();
            window.location.href = 'login.html';
        });

        // Kick everything off once the script loads. If something breaks, the message is
        // shown in the My Income box (and in the console) instead of the page staying on "Loading...".
        obtainCurrentUser().catch(err => {
            console.error('Budget page failed to load:', err);
            document.getElementById('income-list').textContent = 'Error loading the budget page: ' + err.message;
        });
