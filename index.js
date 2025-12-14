import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// --- 核心配置 ---
const extensionName = "silent_summarizer";
const scriptUrl = import.meta.url;
const extensionFolderPath = scriptUrl.substring(0, scriptUrl.lastIndexOf('/'));

// 1. 您指定的系统提示词 (v16版)
const SYSTEM_PROMPT = `
请将提供的对话内容总结为按时间顺序排列的核心事件列表。

【核心事件】[用一句话概括核心主题]

• [第一关键情节点：包含主要人物动作、关键对话及情感变化]
• [第二关键情节点：包含主要人物动作、关键对话及情感变化]
• [后续关键情节点：保持同样格式，按时间顺序排列]

要求：
1. 只提取推动剧情发展的核心事件
2. 每个情节点用完整叙述句描述
3. 保持第三人称客观视角
4. 忽略重复性日常细节，但对于NSFW内容请保持客观描述。
`;

// 2. 世界书关键词提取提示词 (v16版)
const WI_PROMPT = `
基于以下剧情总结，生成一个世界书(World Info)条目。
提取最核心的一个名词（地点/物品/事件/概念）。

输出格式(JSON):
{
    "keys": "关键词1, 关键词2",
    "entry": "详细条目内容...",
    "depth": 2
}
`;

const defaultSettings = {
    enabled: true,
    provider: 'openai',
    url: 'http://127.0.0.1:5000/v1',
    apiKey: '',
    model: 'gpt-3.5-turbo',
    autoBookName: 'SilentSummaries',
    systemPrompt: SYSTEM_PROMPT.trim()
};

// 状态
const state = {
    isOpen: false,
    summaryResult: '',
    activeTab: 'manual',
    tempS: '', tempE: ''
};

// --- 网络核心 (修复版) ---

function getNativeCsrfToken() {
    if (window.SillyTavern?.getContext) return window.SillyTavern.getContext().csrfToken;
    const m = document.cookie.match(/csrf_token=([^;]+)/);
    return m ? m[1] : null;
}

// 增加 credentials: 'include' 以修复手机端 Cookie 问题
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

// --- 消息处理 ---

function getMessages(start, end) {
    const els = Array.from(document.querySelectorAll('.mes'));
    const msgs = [];
    els.forEach(el => {
        const mesId = parseInt(el.getAttribute('mesid'));
        if (isNaN(mesId)) return;
        if (el.style.display === 'none' || el.classList.contains('hidden')) return;
        if (start !== undefined && mesId < start) return;
        if (end !== undefined && mesId > end) return;
        
        const nameEl = el.querySelector('.name_text');
        const textEl = el.querySelector('.mes_text');
        msgs.push({ 
            floor: mesId, 
            sender: nameEl ? nameEl.innerText.trim() : '?', 
            content: textEl ? textEl.innerText.trim() : '' 
        });
    });
    return msgs;
}

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

    console.log("[SS] Calling API:", targetUrl);
    const res = await fetch(targetUrl, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json();
    
    if (data.error) throw new Error(JSON.stringify(data.error));
    const result = provider === 'gemini' ? data.candidates?.[0]?.content?.parts?.[0]?.text : data.choices?.[0]?.message?.content;
    if (!result) throw new Error("API返回内容为空");
    return result;
}

async function performSummary(s, e) {
    const msgs = getMessages(s, e);
    if(!msgs.length) throw new Error("该范围内没有有效消息");
    const conversation = msgs.map(m => `${m.sender}: ${m.content}`).join('\n');
    // 使用设置里的 Prompt (默认即为您指定的 v16 格式)
    const prompt = extension_settings[extensionName].systemPrompt;
    return await callLlmApi(prompt, conversation);
}

// --- 世界书注入逻辑 (完全复刻 v16 逻辑) ---
async function performWiInjection(content, bookName) {
    if (!bookName) bookName = "SilentSummaries";

    // 1. 第一步：调用 LLM 提取关键词和结构 (v16 逻辑)
    let entryData = { keys: "Summary", entry: content, depth: 2 };
    try {
        console.log("[SS] Generating WI Keys...");
        const wiRaw = await callLlmApi(WI_PROMPT, content);
        // 尝试解析 JSON
        const jsonMatch = wiRaw.match(/\{.*\}/s);
        const jsonStr = jsonMatch ? jsonMatch[0] : wiRaw;
        const json = JSON.parse(jsonStr);
        entryData = { ...entryData, ...json };
    } catch (e) {
        console.warn("[SS] JSON Parse failed, using default values", e);
    }

    // 2. 第二步：获取或创建世界书 (v16 Fire and Forget)
    let bookData = { entries: {} };
    try {
        const r = await stFetch('/api/worldinfo/get', { method: 'POST', body: JSON.stringify({ name: bookName }) });
        if(r && r.entries) bookData = r;
    } catch(e) {
        console.log("[SS] Book not found, creating new one:", bookName);
    }

    // 3. 第三步：构建条目
    const uid = Date.now();
    bookData.entries[uid] = { 
        key: entryData.keys.split(',').map(k=>k.trim()), 
        content: entryData.entry, 
        depth: parseInt(entryData.depth) || 2, 
        selective: true, 
        uid, 
        comment: "SilentSummarizer" 
    };

    // 4. 第四步：保存
    await stFetch('/api/worldinfo/edit', { method: 'POST', body: JSON.stringify({ name: bookName, data: bookData }) });
    alert(`✅ 已保存到 "${bookName}"\n关键词: ${entryData.keys}`);
}

// --- UI 构建 ---
function createFloatUI() {
    if (document.getElementById('ss-container')) return;
    const root = document.createElement('div');
    root.id = 'ss-container';
    
    root.innerHTML = `
        <div id="ss-float"><div class="dot"></div></div>
        <div id="ss-win">
            <div class="ss-head">
                <span style="font-weight:bold;color:#a78bfa">Silent Summarizer</span>
                <span id="ss-close" style="cursor:pointer;font-size:20px;padding:0 8px;">×</span>
            </div>
            <div class="ss-body"></div>
        </div>
    `;
    document.body.appendChild(root);
    
    const win = root.querySelector('#ss-win');
    const float = root.querySelector('#ss-float');
    const body = root.querySelector('.ss-body');
    
    // 拖拽逻辑
    let isDragging = false, startX, startY, initialLeft, initialTop, hasMoved = false;
    const onStart = (e) => {
        isDragging = true; hasMoved = false;
        const t = e.touches ? e.touches[0] : e;
        startX = t.clientX; startY = t.clientY;
        const rect = float.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
    };
    const onMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const t = e.touches ? e.touches[0] : e;
        const dx = t.clientX - startX; const dy = t.clientY - startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasMoved = true;
        float.style.right = 'auto'; 
        float.style.left = (initialLeft + dx) + 'px';
        float.style.top = (initialTop + dy) + 'px';
    };
    const onEnd = () => { isDragging = false; };

    float.addEventListener('touchstart', onStart, {passive: false});
    document.addEventListener('touchmove', onMove, {passive: false});
    document.addEventListener('touchend', onEnd);
    float.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);

    float.onclick = () => { 
        if (hasMoved) return;
        state.isOpen = !state.isOpen;
        win.style.display = state.isOpen ? 'flex' : 'none';
        if(state.isOpen) renderWin(body);
    };
    root.querySelector('#ss-close').onclick = () => { state.isOpen = false; win.style.display = 'none'; };

    window._ss_open_ui = () => {
        state.isOpen = true;
        win.style.display = 'flex';
        renderWin(body);
    };
}

function renderWin(body) {
    const settings = extension_settings[extensionName];

    if(state.activeTab === 'manual') {
        const msgs = getMessages();
        if(!state.tempS) state.tempS = msgs.length ? msgs[0].floor : 0;
        if(!state.tempE) state.tempE = msgs.length ? msgs[msgs.length-1].floor : 0;

        body.innerHTML = `
            <div style="margin-bottom:10px;font-size:13px;color:#9ca3af">选择楼层范围 (Start - End):</div>
            <div class="ss-row">
                <input class="ss-input" type="number" id="ss-s" value="${state.tempS}">
                <span>至</span>
                <input class="ss-input" type="number" id="ss-e" value="${state.tempE}">
            </div>
            <button class="ss-btn" id="ss-go">✨ 生成剧情总结</button>
            <div style="margin-top:15px;border-top:1px solid #374151;padding-top:10px;">
                <button class="ss-btn gray" id="ss-cfg" style="font-size:12px;padding:6px;">⚙️ API 设置</button>
            </div>
            ${state.summaryResult ? `
                <div style="margin-top:15px; padding:10px; background:#1f2937; border-radius:6px; border:1px solid #7c3aed;">
                    <textarea class="ss-input" style="height:120px;margin-top:0;">${state.summaryResult}</textarea>
                    <button class="ss-btn green" id="ss-save">📂 智能生成条目并存入世界书</button>
                    <div style="font-size:10px;color:#aaa;margin-top:5px;text-align:center;">书名: ${settings.autoBookName}</div>
    </div>`:''}
        `;
        body.querySelector('#ss-s').oninput=e=>state.tempS=e.target.value;
        body.querySelector('#ss-e').oninput=e=>state.tempE=e.target.value;
        body.querySelector('#ss-go').onclick=async(e)=>{ 
            e.target.innerText='正在生成...'; 
            try{state.summaryResult=await performSummary(state.tempS,state.tempE);renderWin(body);}
            catch(err){alert(err.message);renderWin(body);} 
        };
        body.querySelector('#ss-cfg').onclick=()=>{state.activeTab='settings';renderWin(body);};
        if(state.summaryResult) body.querySelector('#ss-save').onclick=async(e)=>{
            e.target.innerText='正在分析关键词...';
            try { await performWiInjection(state.summaryResult, settings.autoBookName); }
            catch(err) { alert(err.message); }
            finally { renderWin(body); }
        };
    } else {
        body.innerHTML = `
            <label style="font-size:12px">Provider</label>
            <select class="ss-input" id="c-p"><option value="openai" ${settings.provider==='openai'?'selected':''}>OpenAI</option><option value="gemini" ${settings.provider==='gemini'?'selected':''}>Gemini</option></select>
            <label style="font-size:12px">URL</label><input class="ss-input" id="c-u" value="${settings.url}">
            <label style="font-size:12px">Key</label><input type="password" class="ss-input" id="c-k" value="${settings.apiKey}">
            <label style="font-size:12px">世界书名称</label><input class="ss-input" id="c-bn" value="${settings.autoBookName}">
            <div class="ss-row"><button class="ss-btn" id="c-save">保存配置</button><button class="ss-btn gray" id="c-back">返回</button></div>
        `;
        body.querySelector('#c-save').onclick=()=>{
            settings.provider=body.querySelector('#c-p').value;
            settings.url=body.querySelector('#c-u').value;
            settings.apiKey=body.querySelector('#c-k').value;
            settings.autoBookName=body.querySelector('#c-bn').value;
            saveSettingsDebounced(); 
            alert("配置已保存");
        };
        body.querySelector('#c-back').onclick=()=>{state.activeTab='manual';renderWin(body);};
    }
}

function updateFloatState() {
    const float = document.getElementById('ss-float');
    const win = document.getElementById('ss-win');
    const isEnabled = extension_settings[extensionName].enabled;
    if (float) {
        float.style.display = isEnabled ? 'flex' : 'none';
        if (!isEnabled && win) win.style.display = 'none';
    }
}

// --- 初始化 (jQuery Entry) ---
jQuery(async () => {
    console.log("[SS] Initializing v31...");

    // 1. 初始化设置
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key in defaultSettings) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }

    // 2. 加载 HTML
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch(e) {
        console.error("SS: Failed to load settings.html", e);
    }

    // 3. 绑定事件
    const $block = $("#ss_settings_container");
    
    // 菜单折叠
    $block.find('.inline_drawer_header').click(function() {
        $(this).next('.extension_content').slideToggle();
        $(this).find('.fa-angle-down').toggleClass('fa-angle-up');
    });

    // 启用开关
    const $cb = $block.find("#ss_enabled_cb");
    $cb.prop("checked", extension_settings[extensionName].enabled);
    $cb.on("change", function() {
        extension_settings[extensionName].enabled = $(this).prop("checked");
        saveSettingsDebounced();
        updateFloatState();
    });

    // 提示词输入框 (回显)
    const $prompt = $block.find("#ss_prompt_input");
    $prompt.val(extension_settings[extensionName].systemPrompt);
    $prompt.on("change", function() {
        extension_settings[extensionName].systemPrompt = $(this).val();
        saveSettingsDebounced();
    });

    // 打开按钮
    $block.find("#ss_open_ui_btn").on("click", function() {
        if(window._ss_open_ui) window._ss_open_ui();
    });

    // 4. 初始化
    createFloatUI();
    updateFloatState();

    console.log("[SS] Ready.");
});
