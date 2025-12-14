import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "silent_summarizer";
const scriptUrl = import.meta.url;
const extensionFolderPath = scriptUrl.substring(0, scriptUrl.lastIndexOf('/'));

// v16 核心提示词
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
    autoEnabled: false,
    autoThreshold: 20,
    autoKeep: 5
};
// --- END PART 1 ---


const state = {
    isOpen: false,
    activeTab: 'manual',
    startFloor: '', endFloor: '',
    summaryResult: '',
    wiEntries: [], availableBooks: [],
    expandedCards: new Set()
};

function getNativeCsrfToken() {
    if (window.SillyTavern?.getContext) return window.SillyTavern.getContext().csrfToken;
    const m = document.cookie.match(/csrf_token=([^;]+)/);
    return m ? m[1] : null;
}

// 修复：添加 credentials: 'include'
async function stFetch(endpoint, options = {}) {
    const headers = options.headers || {};
    headers['Content-Type'] = 'application/json';
    headers['X-Requested-With'] = 'XMLHttpRequest';
    const token = getNativeCsrfToken();
    if (token) headers['X-CSRF-Token'] = token;
    const fetchOptions = { ...options, headers, credentials: 'include' };
    const res = await fetch(endpoint, fetchOptions);
    if (!res.ok) throw new Error(`API Error ${res.status}`);
    return res.json();
}

function getMessages() {
    const els = Array.from(document.querySelectorAll('.mes'));
    return els.map(el => {
        const id = parseInt(el.getAttribute('mesid'));
        if (isNaN(id)) return null;
        if (el.style.display === 'none' || el.classList.contains('hidden')) return { floor: id, isHidden: true };
        const n = el.querySelector('.name_text');
        const t = el.querySelector('.mes_text');
        return { floor: id, sender: n?n.innerText.trim():'?', content: t?t.innerText.trim():'', isHidden: false };
    }).filter(m => m !== null);
}

function executeSlash(cmd) {
    if (window.SillyTavern?.getContext) window.SillyTavern.getContext().executeCommand(cmd);
    else if (window.executeSlashCommands) window.executeSlashCommands(cmd);
}
// --- END PART 2 ---


async function callLlmApi(prompt, content) {
    const settings = extension_settings[extensionName];
    const { apiKey, url, provider, model } = settings;
    if (!url) throw new Error("URL未设置");
    
    let target = url;
    let body = {};
    let headers = { 'Content-Type': 'application/json' };
    
    if (provider === 'gemini') {
        if(!url.includes('key=') && apiKey) target = `${url}?key=${apiKey}`;
        body = { contents: [{ role: "user", parts: [{ text: content }] }], systemInstruction: { parts: [{ text: prompt }] } };
    } else {
        if(!target.endsWith('/chat/completions') && provider!=='openai') target = target.replace(/\/$/, '')+'/chat/completions';
        if(apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        body = { model: model||'gpt-3.5-turbo', messages: [{role:'system',content:prompt}, {role:'user',content:content}] };
    }
    
    const res = await fetch(target, { method:'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    if(data.error) throw new Error(JSON.stringify(data.error));
    const txt = provider==='gemini' ? data.candidates?.[0]?.content?.parts?.[0]?.text : data.choices?.[0]?.message?.content;
    if(!txt) throw new Error("API返回空");
    return txt;
}

async function performSummary(s, e) {
    const msgs = getMessages().filter(m => m.floor >= s && m.floor <= e && !m.isHidden);
    if(!msgs.length) throw new Error("范围内无消息");
    const text = msgs.map(m => `${m.sender}: ${m.content}`).join('\n');
    return await callLlmApi(extension_settings[extensionName].systemPrompt, text);
}

async function performWiInjection(content, book) {
    if(!book) book = "SilentSummaries";
    let entry = { keys: "Summary", entry: content, depth: 2 };
    try {
        const raw = await callLlmApi(WI_PROMPT, content);
        const json = JSON.parse(raw.match(/\{.*\}/s)?.[0] || raw);
        entry = { ...entry, ...json };
    } catch(e) {}
    
    let data = { entries: {} };
    try { data = await stFetch('/api/worldinfo/get', { method:'POST', body:JSON.stringify({name:book}) }); } catch(e){}
    if(!data.entries) data.entries = {};
    
    const uid = Date.now();
    data.entries[uid] = { key: entry.keys.split(','), content: entry.entry, depth: entry.depth, selective: true, uid, comment: "SS Auto" };
    await stFetch('/api/worldinfo/edit', { method:'POST', body:JSON.stringify({name:book, data}) });
    alert(`✅ 已存入: ${book}`);
}
// --- END PART 3 ---


// --- UI: Tab 1 & 2 (Manual/Auto) ---
async function renderTab(tab) {
    const c = document.getElementById('ss-tab-content');
    const S = extension_settings[extensionName];
    c.innerHTML = '';

    if (tab === 'manual') {
        c.innerHTML = `
            <div class="ss-card">
                <label class="ss-label">范围</label>
                <div style="display:flex;gap:5px"><input id="ss-s" class="ss-input" type="number" value="${state.startFloor}"><input id="ss-e" class="ss-input" type="number" value="${state.endFloor}"></div>
                <button id="ss-gen" class="ss-btn">✨ 开始总结</button>
            </div>
            ${state.summaryResult ? `
                <div class="ss-card" style="border-color:#7c3aed">
                    <textarea class="ss-input" style="height:100px">${state.summaryResult}</textarea>
                    <button id="ss-save" class="ss-btn green">📂 存入世界书</button>
                    <button id="ss-hide" class="ss-btn gray">🙈 隐藏楼层</button>
                </div>`:''}
            <button id="ss-unhide" class="ss-btn gray">显示隐藏楼层</button>
        `;
        c.querySelector('#ss-s').oninput=e=>state.startFloor=e.target.value;
        c.querySelector('#ss-e').oninput=e=>state.endFloor=e.target.value;
        c.querySelector('#ss-gen').onclick=async(e)=>{
            e.target.innerText='...'; try{state.summaryResult=await performSummary(state.startFloor,state.endFloor);renderTab('manual');}catch(err){alert(err.message);renderTab('manual');}
        };
        if(state.summaryResult){
            c.querySelector('#ss-save').onclick=()=>performWiInjection(state.summaryResult, S.autoBookName);
            c.querySelector('#ss-hide').onclick=()=>executeSlash(`/hide ${state.startFloor}-${state.endFloor}`);
        }
        c.querySelector('#ss-unhide').onclick=()=>executeSlash('/unhide');
    }
    else if (tab === 'auto') {
        c.innerHTML = `
            <div class="ss-card">
                <label><input type="checkbox" id="a-en" ${S.autoEnabled?'checked':''}> 启用自动模式</label>
                <hr style="border:0;border-top:1px solid #333;margin:10px 0">
                <label class="ss-label">阈值</label><input id="a-th" class="ss-input" type="number" value="${S.autoThreshold}">
                <label class="ss-label">保留</label><input id="a-kp" class="ss-input" type="number" value="${S.autoKeep}">
                <label class="ss-label">书名</label><input id="a-bn" class="ss-input" value="${S.autoBookName}">
                <button id="a-save" class="ss-btn">保存设置</button>
            </div>
        `;
        c.querySelector('#a-save').onclick=()=>{
            S.autoEnabled=c.querySelector('#a-en').checked;
            S.autoThreshold=c.querySelector('#a-th').value;
            S.autoKeep=c.querySelector('#a-kp').value;
            S.autoBookName=c.querySelector('#a-bn').value;
            saveSettingsDebounced(); alert("已保存");
        };
    }
    // (Next part...)
// --- END PART 4 ---


    // --- UI: Tab 3, 4, 5 ---
    else if (tab === 'wi') {
        try{ if(!state.availableBooks.length) { const d=await stFetch('/api/worldinfo/get_names',{method:'POST',body:'{}'}); state.availableBooks=d.names||d; } }catch(e){}
        const opts = state.availableBooks.map(b=>`<option value="${b}" ${b===S.autoBookName?'selected':''}>${b}</option>`).join('');
        c.innerHTML = `<div class="ss-card"><select id="w-sel" class="ss-input">${opts}</select><button id="w-load" class="ss-btn gray">刷新内容</button></div><div id="w-list"></div>`;
        c.querySelector('#w-sel').onchange=e=>{S.autoBookName=e.target.value;saveSettingsDebounced();};
        const load=async()=>{
            const l=c.querySelector('#w-list'); l.innerHTML='Loading...';
            try{
                const r=await stFetch('/api/worldinfo/get',{method:'POST',body:JSON.stringify({name:S.autoBookName})});
                l.innerHTML='';
                Object.values(r.entries||{}).reverse().forEach(e=>{
                    const d=document.createElement('div'); d.className='ss-card'; const ex=state.expandedCards.has(e.uid);
                    d.innerHTML=`<b>${(e.key||[]).join(', ').slice(0,20)}</b> ${ex?e.content:'...'}`;
                    d.onclick=()=>{ ex?state.expandedCards.delete(e.uid):state.expandedCards.add(e.uid); load(); };
                    l.appendChild(d);
                });
            }catch(e){l.innerHTML='Error';}
        };
        c.querySelector('#w-load').onclick=load; load();
    }
    else if (tab === 'data') {
        c.innerHTML = `
            <div class="ss-card"><label class="ss-label">导入配置 (JSON)</label><textarea id="d-in" class="ss-input"></textarea><button id="d-imp" class="ss-btn green">导入</button></div>
            <div class="ss-card"><label class="ss-label">导出配置</label><textarea class="ss-input" readonly>${JSON.stringify(S)}</textarea></div>
        `;
        c.querySelector('#d-imp').onclick=()=>{ try{Object.assign(S,JSON.parse(c.querySelector('#d-in').value));saveSettingsDebounced();alert("导入成功");}catch(e){alert("格式错误");} };
    }
    else if (tab === 'settings') {
        c.innerHTML=`
            <div class="ss-card">
                <label class="ss-label">API URL</label><input id="s-u" class="ss-input" value="${S.url}">
                <label class="ss-label">API Key</label><input type="password" id="s-k" class="ss-input" value="${S.apiKey}">
                <label class="ss-label">Prompt</label><textarea id="s-p" class="ss-input" rows="5">${S.systemPrompt}</textarea>
                <button id="s-save" class="ss-btn">保存</button>
            </div>
        `;
        c.querySelector('#s-save').onclick=()=>{ S.url=c.querySelector('#s-u').value; S.apiKey=c.querySelector('#s-k').value; S.systemPrompt=c.querySelector('#s-p').value; saveSettingsDebounced(); alert("已保存"); };
    }
}
// --- END PART 5 ---


// --- INIT ---
function createUI() {
    if (document.getElementById('ss-root')) return;
    const root = document.createElement('div'); root.id = 'ss-root'; document.body.appendChild(root);
    
    // Float Button
    const btn = document.createElement('div'); btn.id='ss-float-btn'; btn.innerHTML='📝'; root.appendChild(btn);
    
    // Overlay
    const ol = document.createElement('div'); ol.className='ss-modal-overlay';
    ol.innerHTML = `
        <div class="ss-modal">
            <div style="padding:10px;background:#111;display:flex;justify-content:space-between;align-items:center"><b>SS v34</b><span id="ss-x" style="padding:5px">×</span></div>
            <div class="ss-tabs">
                <button class="ss-tab active" data-t="manual">手动</button><button class="ss-tab" data-t="auto">自动</button>
                <button class="ss-tab" data-t="wi">世界书</button><button class="ss-tab" data-t="data">数据</button>
                <button class="ss-tab" data-t="settings">设置</button>
            </div>
            <div class="ss-content" id="ss-tab-content"></div>
        </div>
    `;
    root.appendChild(ol);

    // Events
    const close=()=>{ ol.style.display='none'; state.isOpen=false; };
    const open=()=>{ 
        ol.style.display='flex'; state.isOpen=true; 
        const m = getMessages();
        if(m.length) { state.startFloor=m[0].floor; state.endFloor=m[m.length-1].floor; }
        renderTab('manual');
    };
    
    ol.querySelector('#ss-x').onclick=close;
    ol.onclick=e=>{if(e.target===ol)close();};
    btn.onclick=open;
    window._ss_open_ui=open;

    ol.querySelectorAll('.ss-tab').forEach(t=>{
        t.onclick=()=>{
            state.activeTab=t.dataset.t;
            ol.querySelectorAll('.ss-tab').forEach(x=>x.classList.toggle('active',x.dataset.t===state.activeTab));
            renderTab(state.activeTab);
        }
    });
}

jQuery(async () => {
    try {
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        for(const k in defaultSettings) if(extension_settings[extensionName][k]===undefined) extension_settings[extensionName][k]=defaultSettings[k];

        const html = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(html);
        
        $("#ss_settings_container .inline_drawer_header").click(function(){ $(this).next().slideToggle(); });
        
        $("#ss_enabled_cb").prop("checked", extension_settings[extensionName].enabled).on("change", function(){
            extension_settings[extensionName].enabled = $(this).prop("checked");
            saveSettingsDebounced();
            $("#ss-float-btn").toggle($(this).prop("checked"));
        });
        
        $("#ss_open_ui_btn").click(()=>window._ss_open_ui && window._ss_open_ui());
        
        createUI();
        if(!extension_settings[extensionName].enabled) $("#ss-float-btn").hide();
        console.log("SS v34 Loaded");
    } catch(e) { console.error("SS Init Error", e); }
});
// --- END PART 6 ---
