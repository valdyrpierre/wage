// Finance assistant widget: a floating avatar (bottom right) that opens a small chat popup.
// The question goes to a Supabase Edge Function ("finance-assistant"), which reads this person's data
// and asks the AI. No AI key is in this file.
(function ()
{
    const FUNCTION_URL = 'https://wuuxogpncyixwxmlhdkz.supabase.co/functions/v1/finance-assistant';
    const HISTORY_KEY = 'assistantChat';
    const MAX_SENT = 10;
    const SUGGESTIONS = [
        'Can I afford a $15/month subscription?',
        'How much will I have left this month?',
        'Which bills are still unpaid?'
    ];

    let busy = false;
    let history = [];                       // [{ role, content }]
    let els = {};

    // ---------- storage (wrapped: private windows can throw) ----------
    function loadHistory()
    {
        try
        {
            const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]');
            return Array.isArray(saved) ? saved.filter(m => m && typeof m.content === 'string') : [];
        }
        catch (e) { return []; }
    }

    function saveHistory()
    {
        try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-40))); } catch (e) { }
    }

    // ---------- safe text rendering (never innerHTML) ----------
    function addInline(parent, text)
    {
        // **bold** only; everything else stays plain text
        text.split(/(\*\*[^*]+\*\*)/g).forEach(part =>
        {
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
            {
                const b = document.createElement('strong');
                b.textContent = part.slice(2, -2);
                parent.appendChild(b);
            }
            else if (part)
            {
                parent.appendChild(document.createTextNode(part));
            }
        });
    }

    function renderRich(container, text)
    {
        let list = null;
        text.split('\n').forEach(line =>
        {
            const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
            if (bullet)
            {
                if (!list) { list = document.createElement('ul'); container.appendChild(list); }
                const li = document.createElement('li');
                addInline(li, bullet[1]);
                list.appendChild(li);
                return;
            }
            list = null;
            if (line.trim() === '') return;
            const p = document.createElement('p');
            addInline(p, line.replace(/^#+\s*/, ''));
            container.appendChild(p);
        });
    }

    // ---------- message bubbles ----------
    function addBubble(role, text)
    {
        const bubble = document.createElement('div');
        bubble.className = 'fa-msg ' + (role === 'user' ? 'fa-user' : role === 'error' ? 'fa-error' : 'fa-bot');
        if (role === 'assistant') renderRich(bubble, text); else bubble.textContent = text;
        els.log.appendChild(bubble);
        els.log.scrollTop = els.log.scrollHeight;
        return bubble;
    }

    function addTyping()
    {
        const bubble = document.createElement('div');
        bubble.className = 'fa-msg fa-bot';
        const dots = document.createElement('span');
        dots.className = 'fa-typing';
        dots.setAttribute('aria-label', 'Assistant is typing');
        for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
        bubble.appendChild(dots);
        els.log.appendChild(bubble);
        els.log.scrollTop = els.log.scrollHeight;
        return bubble;
    }

    function renderAll()
    {
        els.log.textContent = '';
        addBubble('assistant', "Hi! I can look at your pay, bills and scheduled shifts and help with money decisions. Try asking if you can afford something.");
        history.forEach(m => addBubble(m.role, m.content));
        els.chips.style.display = history.length ? 'none' : 'flex';
    }

    // ---------- talking to the server ----------
    function getClient()
    {
        return (typeof supabaseClient !== 'undefined' && supabaseClient) || window.supabaseClient || null;
    }

    function getTaxRate()
    {
        try
        {
            const saved = parseFloat(localStorage.getItem('taxRate'));
            return Number.isFinite(saved) ? saved : 5;
        }
        catch (e) { return 5; }
    }

    async function askServer()
    {
        const client = getClient();
        if (!client) throw new Error('Not ready yet. Reload the page.');

        const { data } = await client.auth.getSession();
        const session = data && data.session;
        if (!session) throw new Error('Please log in first.');

        let response;
        try
        {
            response = await fetch(FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session.access_token,
                'apikey': client.supabaseKey || ''
            },
            body: JSON.stringify({
                messages: history.slice(-MAX_SENT),
                taxRate: getTaxRate(),
                tzOffset: new Date().getTimezoneOffset()
            })
        });
        }
        catch (networkError)
        {
            throw new Error("Couldn't reach the assistant. Check that the finance-assistant function is deployed with 'Verify JWT' turned off, and that you're on valdyrpierre.github.io.");
        }

        let body = {};
        try { body = await response.json(); } catch (e) { }
        if (!response.ok) throw new Error(body.error || 'Something went wrong (' + response.status + ').');
        return body.reply;
    }

    async function send(text)
    {
        text = (text || '').trim();
        if (!text || busy) return;

        busy = true;
        els.send.disabled = true;
        els.input.value = '';
        els.chips.style.display = 'none';

        history.push({ role: 'user', content: text.slice(0, 1500) });
        saveHistory();
        addBubble('user', text);
        const typing = addTyping();

        try
        {
            const reply = await askServer();
            typing.remove();
            history.push({ role: 'assistant', content: reply });
            saveHistory();
            addBubble('assistant', reply);
        }
        catch (error)
        {
            typing.remove();
            addBubble('error', error.message || 'Something went wrong.');
            history.pop();                  // let the person retry the same question
            saveHistory();
        }

        busy = false;
        els.send.disabled = false;
        els.input.focus();
    }

    // ---------- open / close ----------
    function setOpen(open)
    {
        els.root.classList.toggle('fa-open', open);
        els.avatar.setAttribute('aria-expanded', String(open));
        try { sessionStorage.setItem('assistantOpen', open ? '1' : '0'); } catch (e) { }
        if (open) { els.log.scrollTop = els.log.scrollHeight; els.input.focus(); }
        else els.avatar.focus();
    }

    function clearChat()
    {
        history = [];
        saveHistory();
        renderAll();
    }

    // ---------- build the widget ----------
    function make(tag, className, text)
    {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        return el;
    }

    function buildAvatar()
    {
        // a small friendly robot-coin face, drawn with SVG
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        [
            ['rect', { x: 4, y: 7, width: 16, height: 12, rx: 4 }],
            ['path', { d: 'M12 7V4' }],
            ['circle', { cx: 12, cy: 3.5, r: 1 }],
            ['circle', { cx: 9, cy: 12.5, r: 1, fill: 'currentColor' }],
            ['circle', { cx: 15, cy: 12.5, r: 1, fill: 'currentColor' }],
            ['path', { d: 'M9.5 16c1.5 1 3.5 1 5 0' }]
        ].forEach(([name, attrs]) =>
        {
            const node = document.createElementNS('http://www.w3.org/2000/svg', name);
            Object.keys(attrs).forEach(k => node.setAttribute(k, attrs[k]));
            svg.appendChild(node);
        });
        return svg;
    }

    function build()
    {
        els.root = make('div', 'fa-root');

        els.avatar = make('button', 'fa-avatar');
        els.avatar.type = 'button';
        els.avatar.setAttribute('aria-label', 'Open finance assistant');
        els.avatar.setAttribute('aria-expanded', 'false');
        els.avatar.appendChild(buildAvatar());

        const panel = make('div', 'fa-panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Finance assistant');

        const head = make('div', 'fa-head');
        const title = make('div', 'fa-head-title', 'Finance Assistant');
        title.appendChild(make('small', '', 'Answers from your own data'));
        const clear = make('button', '', '↺');
        clear.type = 'button'; clear.title = 'Clear chat'; clear.setAttribute('aria-label', 'Clear chat');
        const close = make('button', '', '✕');
        close.type = 'button'; close.title = 'Close'; close.setAttribute('aria-label', 'Close assistant');
        head.append(title, clear, close);

        els.log = make('div', 'fa-log');
        els.log.setAttribute('aria-live', 'polite');

        els.chips = make('div', 'fa-chips');
        SUGGESTIONS.forEach(s =>
        {
            const chip = make('button', 'fa-chip', s);
            chip.type = 'button';
            chip.addEventListener('click', () => send(s));
            els.chips.appendChild(chip);
        });

        const form = make('form', 'fa-form');
        els.input = make('input', 'fa-input');
        els.input.type = 'text'; els.input.maxLength = 1000;
        els.input.placeholder = 'Ask about your money...';
        els.input.setAttribute('aria-label', 'Your question');
        els.send = make('button', 'fa-send', 'Send');
        els.send.type = 'submit';
        form.append(els.input, els.send);

        const note = make('div', 'fa-note', 'Estimates only, not financial advice.');

        panel.append(head, els.log, els.chips, form, note);
        els.root.append(panel, els.avatar);
        document.body.appendChild(els.root);

        els.avatar.addEventListener('click', () => setOpen(true));
        close.addEventListener('click', () => setOpen(false));
        clear.addEventListener('click', clearChat);
        form.addEventListener('submit', e => { e.preventDefault(); send(els.input.value); });
        panel.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
    }

    function init()
    {
        if (document.getElementById('fa-root-marker')) return;
        history = loadHistory();
        build();
        renderAll();
        let wasOpen = false;
        try { wasOpen = sessionStorage.getItem('assistantOpen') === '1'; } catch (e) { }
        if (wasOpen) els.root.classList.add('fa-open');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
