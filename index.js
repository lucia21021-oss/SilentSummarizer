import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "silent_summarizer";
const scriptUrl = import.meta.url;
const extensionFolderPath = scriptUrl.substring(0, scriptUrl.lastIndexOf('/'));

// --- 您的 v16 原始提示词 ---
const SYSTEM_PROMPT = `请将提供的对话内容总结为按时间顺序排列的核心事件列表。

【核心事件】[用一句话概括核心主题]

• [第一关键情节点：包含主要人物动作、关键对话及情感变化]
• [第二关键情节点：包含主要人物动作、关键对话及情感变化]
• [后续关键情节点：保持同样格式，按时间顺序排列]

要求：
1. 只提取推动剧情发展的核心事件
2. 每个情节点用完整叙述句描述
3. 保持第三人称客观视角
4. 忽略重复性日常细节，但对于NSFW内容请保持客观描述。`;

const WI_PROMPT = `基于以下剧情总结，生成一个世界书(World Info)条目。
提取最核心的一个名词（地点/物品/事件/概念）。

输出格式(JSON):
{
    "keys": "关键词1, 关键词2",
    "entry": "详细条目内容...",
    "depth": 2
}`;

const defaultSettings = {
    enabled: true,
    provider: 'openai',
    url: 'http://127.0.0.1:5000/v1',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    autoBookName: 'SilentSummaries',
    systemPrompt: SYSTEM_PROMPT.trim(),
    autoEnabled: false,     // 自动功能开关
    autoThreshold: 20,      // 触发阈值
    autoKeep: 5,            // 保留条数
    presets: {}             // 预设方案
};

const state = {
    isOpen: false,
    activeTab: 'manual', // manual, auto, wi, data, settings
    startFloor: '', endFloor: '',
    summaryResult: '',
    wiEntries: [], availableBooks: [],
    expandedCards: new Set(),
    lastAutoCheck: 0
};
// --- END OF PART 1 ---
// --- 网络与辅助功能 ---
function getNativeCsrfToken() {
    if (window.SillyTavern?.getContext) return window.SillyTavern.getContext().csrfToken;
    const m = document.cookie.match(/csrf_token=([^;]+)/);
    return m ? m[1] : null;
}

async function stFetch(endpoint, options = {}) {
    const headers = options.headers || {};
    headers['Content-Type'] = 'application/json';
    headers['X-Requested-With'] = 'XMLHttpRequest';
    const token = getNativeCsrfToken();
    if (token) headers['X-CSRF-Token'] = token;
    // 关键修复：允许凭证以通过手机端认证
    const fetchOptions = { ...options, headers, credentials: 'include' };
    const res = await fetch(endpoint, fetchOptions);
    if (!res.ok) throw new Error(`API Error ${res.status}`);
    return res.json();
}

function getMessagesFromDOM() {
    const els = Array.from(document.querySelectorAll('.mes'));
    return els.map(el => {
        const mesId = parseInt(el.getAttribute('mesid'));
        if (isNaN(mesId)) return null;
        if (el.style.display === 'none' || el.classList.contains('hidden')) return { floor: mesId, isHidden: true };
        const nameEl = el.querySelector('.name_text');
        const textEl = el.querySelector('.mes_text');
        return { 
            floor: mesId, 
            sender: nameEl ? nameEl.innerText.trim() : '?', 
            content: textEl ? textEl.innerText.trim() : '',
            isHidden: false
        };
    }).filter(m => m !== null);
}

function executeSlash(cmd) {
    if (window.SillyTavern?.getContext) {
        window.SillyTavern.getContext().executeCommand(cmd);
    } else if (typeof window.executeSlashCommands === 'function') {
        window.executeSlashCommands(cmd);
    }
}
// --- END OF PART 2 ---
// --- 核心逻辑：LLM 调用与世界书 ---
async function callLlmApi(prompt, userContent) {
    const settings = extension_settings[extensionName];
    const { apiKey, url, provider, model } = settings;
    if (!url) throw new Error("URL未配置");

    let targetUrl = url;
    let body = {};
    let headers = { 'Content-Type': 'application/json' };

    if (provider === 'gemini') {
        if (!url.includes('key=') && apiKey) targetUrl = `${url}?key=${apiKey}`;
        body = { contents: [{ role: "user", parts: [{ text: userContent }] }], systemInstruction: { parts: [{ text: prompt }] } };
    } else {
        if (provider !== 'openai' && !targetUrl.endsWith('/chat/completions')) targetUrl = targetUrl.replace(/\/$/, '') + '/chat/completions';
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        body = { model: model || 'gpt-3.5-turbo', messages: [{ role: "system", content: prompt }, { role: "user", content: userContent }] };
    }

    const res = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    
    const result = provider === 'gemini' ? data.candidates?.[0]?.content?.parts?.[0]?.text : data.choices?.[0]?.message?.content;
    if (!result) throw new Error("API返回空内容");
    return result;
}

async function performSummary(s, e) {
    const msgs = getMessagesFromDOM().filter(m => m.floor >= s && m.floor <= e && !m.isHidden);
    if (!msgs.length) throw new Error("范围无效");
    const conversation = msgs.map(m => `${m.sender}: ${m.content}`).join('\n');
    return await callLlmApi(extension_settings[extensionName].systemPrompt, conversation);
}

// 智能存入 (Smart Deposit) 逻辑
async function performWiInjection(content, bookName) {
    if (!bookName) bookName = "SilentSummaries";
    
    // 1. 生成关键词 (Smart Keys)
    let entryData = { keys: "Summary", entry: content, depth: 2 };
    try {
        const wiRaw = await callLlmApi(WI_PROMPT, content);
        const jsonMatch = wiRaw.match(/\{.*\}/s);
        const json = JSON.parse(jsonMatch ? jsonMatch[0] : wiRaw);
        entryData = { ...entryData, ...json };
    } catch(e) { console.warn("JSON解析失败，使用默认值"); }

    // 2. 获取书籍
    let bookData = { entries: {} };
    try {
        const r = await stFetch('/api/worldinfo/get', { method: 'POST', body: JSON.stringify({ name: bookName }) });
        if(r && r.entries) bookData = r;
    } catch(e) {}

    // 3. 写入条目
    const uid = Date.now();
    bookData.entries[uid] = { 
        key: entryData.keys.split(',').map(k=>k.trim()), 
        content: entryData.entry, 
        depth: parseInt(entryData.depth) || 2, 
        selective: true, uid, comment: "SilentSummarizer" 
    };
    await stFetch('/api/worldinfo/edit', { method: 'POST', body: JSON.stringify({ name: bookName, data: bookData }) });
    alert(`✅ 已存入: ${bookName}\n关键词: ${entryData.keys}`);
}
// --- END OF PART 3 ---
// --- UI 渲染逻辑 (5个标签页) ---
async function renderTab(tab) {
    const c = document.getElementById('ss-tab-content');
    const settings = extension_settings[extensionName];
    c.innerHTML = '';

    // 1. 手动总结 (Manual)
    if (tab === 'manual') {
        c.innerHTML = `
            <div class="ss-card" style="padding:10px;">
                <div class="ss-label">剧情范围</div>
                <div class="ss-row">
                    <input type="number" id="ss-s" class="ss-input" value="${state.startFloor}">
                    <span>-</span>
                    <input type="number" id="ss-e" class="ss-input" value="${state.endFloor}">
                </div>
                <button id="ss-gen" class="ss-btn">✨ 一键总结</button>
            </div>
            ${state.summaryResult ? `
                <div class="ss-card" style="padding:10px; border:1px solid #7c3aed">
                    <div class="ss-label">结果</div>
                    <textarea class="ss-input" style="height:100px">${state.summaryResult}</textarea>
                    <button id="ss-save-wi" class="ss-btn green">📂 智能存入世界书</button>
                    <button id="ss-hide" class="ss-btn gray">🙈 隐藏这些楼层</button>
                </div>
            `:''}
            <button id="ss-unhide" class="ss-btn gray" style="margin-top:10px">显示所有隐藏楼层</button>
        `;
        // 绑定事件...
        c.querySelector('#ss-s').oninput=e=>state.startFloor=e.target.value;
        c.querySelector('#ss-e').oninput=e=>state.endFloor=e.target.value;
        c.querySelector('#ss-gen').onclick=async(e)=>{
            e.target.innerText='生成中...';
            try{state.summaryResult=await performSummary(state.startFloor,state.endFloor);renderTab('manual');}
            catch(err){alert(err.message);renderTab('manual');}
        };
        if(state.summaryResult){
            c.querySelector('#ss-save-wi').onclick=()=>performWiInjection(state.summaryResult, settings.autoBookName);
            c.querySelector('#ss-hide').onclick=()=>executeSlash(`/hide ${state.startFloor}-${state.endFloor}`);
        }
        c.querySelector('#ss-unhide').onclick=()=>executeSlash('/unhide');
    }

    // 2. 自动总结 (Auto) - 恢复配置功能
    else if (tab === 'auto') {
        c.innerHTML = `
            <div class="ss-card" style="padding:10px;">
                 <div class="ss-label">自动设置</div>
                 <label style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                    <input type="checkbox" id="a-en" ${settings.autoEnabled?'checked':''}> 开启自动检测
                 </label>
                 <div class="ss-form-group"><label class="ss-label">触发阈值 (条)</label><input id="a-th" class="ss-input" type="number" value="${settings.autoThreshold}"></div>
                 <div class="ss-form-group"><label class="ss-label">保留最新 (条)</label><input id="a-kp" class="ss-input" type="number" value="${settings.autoKeep}"></div>
                 <div class="ss-form-group"><label class="ss-label">存入书名</label><input id="a-bn" class="ss-input" value="${settings.autoBookName}"></div>
                 <button id="a-save" class="ss-btn">保存自动设置</button>
            </div>
            <div style="font-size:12px;color:#888;">当新消息超过阈值时，自动总结旧消息并存入世界书。</div>
        `;
        c.querySelector('#a-save').onclick=()=>{
            settings.autoEnabled = c.querySelector('#a-en').checked;
            settings.autoThreshold = parseInt(c.querySelector('#a-th').value);
            settings.autoKeep = parseInt(c.querySelector('#a-kp').value);
            settings.autoBookName = c.querySelector('#a-bn').value;
            saveSettingsDebounced(); alert("已保存");
        };
    }

    // 3. 世界书 (WI)
    else if (tab === 'wi') {
        // ...加载书籍列表逻辑(同v32)...
        try { if(!state.availableBooks.length) { const d = await stFetch('/api/worldinfo/get_names', { method: 'POST', body: '{}' }); state.availableBooks = d.names || d; } } catch(e){}
        const opts = state.availableBooks.map(b => `<option value="${b}" ${b===settings.autoBookName?'selected':''}>${b}</option>`).join('');
        c.innerHTML = `<div class="ss-form-group"><label class="ss-label">选择书籍</label><select id="w-sel" class="ss-select">${opts}</select></div><div id="w-list"></div><button id="w-load" class="ss-btn gray">刷新列表</button>`;
        const load = async () => {
             const list = c.querySelector('#w-list'); list.innerHTML='Loading...';
             const r = await stFetch('/api/worldinfo/get', { method:'POST', body:JSON.stringify({name:settings.autoBookName}) });
             list.innerHTML = '';
             Object.values(r.entries||{}).reverse().forEach(e=>{
                 const d=document.createElement('div'); d.className='ss-card'; const ex=state.expandedCards.has(e.uid);
                 d.innerHTML=`<div class="ss-card-head"><span>${(e.key||[]).join(', ').slice(0,20)}</span><span>${ex?'▼':'▶'}</span></div>${ex?`<div class="ss-card-body">${e.content}</div>`:''}`;
                 d.firstChild.onclick=()=>{ ex?state.expande
// --- 初始化与构建 ---
function createUI() {
    if (document.getElementById('ss-root')) return;
    const root = document.createElement('div'); root.id = 'ss-root'; document.body.appendChild(root);
    
    // 悬浮球
    const btn = document.createElement('div'); btn.id='ss-float-btn'; btn.className='ss-pointer-events-auto';
    btn.innerHTML='📝'; root.appendChild(btn);

    // 模态框 (包含5个Tabs)
    const overlay = document.createElement('div'); overlay.className='ss-modal-overlay';
    overlay.innerHTML=`
        <div class="ss-modal">
            <div class="ss-header"><div class="ss-title">Silent Summarizer v33</div><div id="ss-close" style="cursor:pointer;font-size:20px">×</div></div>
            <div class="ss-tabs">
                <button class="ss-tab active" data-t="manual">手动</button>
                <button class="ss-tab" data-t="auto">自动</button>
                <button class="ss-tab" data-t="wi">世界书</button>
                <button class="ss-tab" data-t="data">数据</button>
                <button class="ss-tab" data-t="settings">设置</button>
            </div>
            <div class="ss-content" id="ss-tab-content"></div>
        </div>
    `;
    root.appendChild(overlay);

    // 事件绑定
    const close=()=>{overlay.style.display='none';state.isOpen=false;};
    overlay.querySelector('#ss-close').onclick=close;
    overlay.onclick=e=>{if(e.target===overlay)close();};

    const open=()=>{
        overlay.style.display='flex'; state.isOpen=true;
        const msgs = getMessagesFromDOM();
        if(msgs.length) { state.startFloor=msgs[0].floor; state.endFloor=msgs[msgs.length-1].floor; }
        renderTab('manual');
    };
    btn.onclick=e=>{if(!btn.hasMoved)open();};
    window._ss_open_ui=open;

    // Tab切换
    overlay.querySelectorAll('.ss-tab').forEach(t=>{
        t.onclick=()=>{
            state.activeTab=t.dataset.t;
            overlay.querySelectorAll('.ss-tab').forEach(x=>x.classList.toggle('active',x.dataset.t===state.activeTab));
            renderTab(state.activeTab);
        };
    });

    // 拖拽逻辑 (Touch优化)
    let isDragging=false, startX, startY, initL, initT;
    const start=e=>{btn.hasMoved=false;const t=e.touches?e.touches[0]:e;startX=t.clientX;startY=t.clientY;const r=btn.getBoundingClientRect();initL=r.left;initT=r.top;isDragging=true;};
    const move=e=>{if(!isDragging)return;e.preventDefault();const t=e.touches?e.touches[0]:e;const dx=t.clientX-startX;const dy=t.clientY-startY;if(Math.abs(dx)>5||Math.abs(dy)>5)btn.hasMoved=true;btn.style.left=(initL+dx)+'px';btn.style.top=(initT+dy)+'px';btn.style.right='auto';};
    const end=()=>{isDragging=false;};
    btn.addEventListener('touchstart',start,{passive:false});document.addEventListener('touchmove',move,{passive:false});document.addEventListener('touchend',end);
    btn.addEventListener('mousedown',start);document.addEventListener('mousemove',move);document.addEventListener('mouseup',end);
}

// 启动入口
jQuery(async () => {
    console.log("[SS] Init v33...");
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) { extension_settings[extensionName][key] = defaultSettings[key]; }
    }
    
    try {
        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(html);
        
        $("#ss_settings_container").find('.inline_drawer_header').click(function() {
            $(this).next('.extension_content').slideToggle();
            $(this).find('.fa-angle-down').toggleClass('fa-angle-up');
        });
        
        const $cb = $("#ss_enabled_cb");
        $cb.prop("checked", extension_settings[extensionName].enabled);
        $cb.on("change", function() {
            extension_settings[extensionName].enabled = $(this).prop("checked");
            saveSettingsDebounced();
            const btn = document.getElementById('ss-float-btn');
            if(btn) btn.style.display = $(this).prop("checked") ? 'flex' : 'none';
        });
        $("#ss_open_ui_btn").click(() => { if(window._ss_open_ui) window._ss_open_ui(); });
    } catch(e) {}

    createUI();
    const btn = document.getElementById('ss-float-btn');
    if(btn) btn.style.display = extension_settings[extensionName].enabled ? 'flex' : 'none';
});
// --- END OF PART 5 ---
