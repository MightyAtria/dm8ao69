import { extractAllWords } from '../../utils.js';
import { toastr } from '../../toastr.js';
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxContextSize,
    setExtensionPrompt,
    streamingProcessor,
} from '../../../script.js';
import { getTokenCountAsync } from '../../tokenizers.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { MacrosParser } from '../../macros.js';
import { countWebLlmTokens, generateWebLlmChatPrompt, getWebLlmContextSize, isWebLlmSupported } from '../shared.js';
import { removeReasoningFromString } from '../../reasoning.js';

export { MODULE_NAME };

// -------------------- 常量与模块名 --------------------
const MODULE_NAME = '1_synopsis';

const synopsis_sources = {
    main: 'main',
    webllm: 'webllm',
};

const MAX_HISTORY = 20;
const UI_SELECTORS = {
    container: '#synopsisExtensionDrawerContents',
    settingsMount: '#extensions_settings2',
    source: '#synopsis_source',
    frozen: '#synopsis_frozen',
    scriptwriterPrompt: '#synopsis_scriptwriter_prompt',
    template: '#synopsis_template',
    depth: '#synopsis_depth',
    role: '#synopsis_role',
    position: 'input[name="synopsis_position"]',
    checkEmpty: '#synopsis_check_empty',
    checkWords: '#synopsis_check_words',
    promptWords: '#synopsis_prompt_words',
    promptWordsValue: '#synopsis_prompt_words_value',
    historyCount: '#synopsis_history_count',
    historyCountValue: '#synopsis_history_count_value',
    overrideResponseLength: '#synopsis_override_response_length',
    overrideResponseLengthValue: '#synopsis_override_response_length_value',
    userDemand: '#synopsis_user_demand',
    current: '#synopsis_current',
    status: '#synopsis_status',
    generateNow: '#synopsis_generate_now',
    clear: '#synopsis_clear',
    historySelect: '#synopsis_history_select',
    historyContent: '#synopsis_history_content',
    historyDelete: '#synopsis_history_delete',
    historySave: '#synopsis_history_save',
    presetSelect: '#synopsis_preset_select',
    presetApply: '#synopsis_preset_apply',
    presetStore: '#synopsis_preset_store',
    presetDelete: '#synopsis_preset_delete',
    scriptwriterRestore: '#synopsis_scriptwriter_restore',
    templateRestore: '#synopsis_template_restore',
};

const defaultScriptwriterPrompt = `Based on the current situation, generate a story synopsis for what happens next.
User's preference for this synopsis: {{user_demand}}
{{old_synopsis_reference}}
The synopsis should outline the key events and story beats that will unfold, without spoiling specific details.
Focus on creating an engaging narrative that suits the characters and setting.`;

const defaultTemplate = `The following is a story outline invisible to {{user}}. You should guide them through this story without spoilers.
Synopsis: {{synopsis}}
If the user shows signs of deviating from the story or the current synopsis has been completed, insert <end of current synopsis> in your response as a marker.`;

// -------------------- 状态 --------------------
let inApiCall = false;
let currentSynopsis = '';
let synopsisHistory = []; // [{ id, content, timestamp, userDemand }]
let abortController = null;

const defaultSettings = {
    synopsisFrozen: false,
    source: synopsis_sources.main,
    scriptwriterPrompt: defaultScriptwriterPrompt,
    template: defaultTemplate,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    depth: 2,
    checkEmpty: true,
    checkWords: false,
    promptWords: 500,
    promptMinWords: 100,
    promptMaxWords: 2000,
    promptWordsStep: 50,
    overrideResponseLength: 0,
    overrideResponseLengthMin: 0,
    overrideResponseLengthMax: 4096,
    overrideResponseLengthStep: 16,
    historyCount: 1,
    historyCountMin: 0,
    historyCountMax: 10,
    presets: {
        Adventure: 'an exciting adventure with challenges and discoveries',
        Romance: 'a romantic development between characters',
        'Daily Life': 'casual daily interactions and slice-of-life moments',
        Mystery: 'a mysterious event or puzzle to solve',
        Action: 'intense action sequences and conflicts',
    },
    userDemand: '',
    currentSynopsisId: null,
};

// -------------------- 工具函数 --------------------
function ensureSettings() {
    if (!extension_settings.synopsis) {
        extension_settings.synopsis = {};
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.synopsis[key] === undefined) {
            extension_settings.synopsis[key] = defaultSettings[key];
        }
    }
}

function cloneDefaultsToUserPresetsIfNeeded() {
    // 若用户还没有 presets，克隆默认到用户空间，避免删除默认失败的困惑
    if (!extension_settings.synopsis.presets) {
        extension_settings.synopsis.presets = { ...defaultSettings.presets };
    }
}

function safeGetContext() {
    try {
        const ctx = getContext?.();
        return ctx || { chat: [], name1: 'User', name2: 'Character' };
    } catch {
        return { chat: [], name1: 'User', name2: 'Character' };
    }
}

function stableId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatSynopsisValue(value) {
    const val = (value || '').trim();
    const context = safeGetContext();

    if (!val) return '';

    if (extension_settings.synopsis.template) {
        return substituteParamsExtended(extension_settings.synopsis.template, {
            synopsis: val,
            user: context.name1 || 'User',
        });
    }
    return val;
}

function setSynopsisContext(value, save) {
    const formattedValue = formatSynopsisValue(value);
    // role/position/depth 基础校验
    const role = Object.values(extension_prompt_roles).includes(extension_settings.synopsis.role)
        ? extension_settings.synopsis.role
        : extension_prompt_roles.SYSTEM;

    const position = Object.values(extension_prompt_types).includes(extension_settings.synopsis.position)
        ? extension_settings.synopsis.position
        : extension_prompt_types.IN_PROMPT;

    const depth = Number.isFinite(extension_settings.synopsis.depth) ? extension_settings.synopsis.depth : 2;

    setExtensionPrompt(
        MODULE_NAME,
        formattedValue,
        position,
        depth,
        false,
        role
    );

    if (save) {
        saveSynopsisData();
    }
}

function saveSynopsisData() {
    extension_settings.synopsis.synopsisHistory = synopsisHistory;
    extension_settings.synopsis.currentSynopsis = currentSynopsis;
    saveSettingsDebounced();
}

function updateSynopsisDisplay() {
    const $cur = $(UI_SELECTORS.current);
    const $status = $(UI_SELECTORS.status);
    if ($cur.length) $cur.val(currentSynopsis);
    if ($status.length) {
        if (currentSynopsis) {
            $status.text('Active').addClass('synopsis-active').removeClass('synopsis-empty');
        } else {
            $status.text('Empty').addClass('synopsis-empty').removeClass('synopsis-active');
        }
    }
}

function updateHistoryList() {
    const $select = $(UI_SELECTORS.historySelect);
    if (!$select.length) return;

    $select.empty();
    $select.append('<option value="current">Current Synopsis</option>');

    // 最新在前
    synopsisHistory.forEach((item, index) => {
        const date = new Date(item.timestamp).toLocaleString();
        const label = `Synopsis #${synopsisHistory.length - index} - ${date}`;
        $select.append(`<option value="${item.id}">${label}</option>`);
    });
}

function updatePresetsList() {
    const $select = $(UI_SELECTORS.presetSelect);
    if (!$select.length) return;
    $select.empty();

    // 用户空间 presets
    const presets = extension_settings.synopsis.presets || {};
    $select.append('<option value="">-- Select Preset --</option>');
    for (const [name] of Object.entries(presets)) {
        $select.append(`<option value="${name}">${name}</option>`);
    }
    $select.append('<option value="__custom__">+ Add Custom</option>');
}

function switchSourceControls(value) {
    const $container = $(UI_SELECTORS.container);
    if (!$container.length) return;
    $(`${UI_SELECTORS.container} [data-synopsis-source]`).each((_, el) => {
        const srcList = (el.dataset.synopsisSource || '')
            .split(',')
            .map(s => s.trim());
        $(el).toggle(srcList.includes(value));
    });
}

async function countSourceTokens(text, padding = 0) {
    try {
        if (extension_settings.synopsis.source === synopsis_sources.webllm) {
            const count = await countWebLlmTokens(text || '');
            return count + padding;
        }
        return await getTokenCountAsync(text || '', padding);
    } catch {
        // 降级为字符长度估算
        return (text || '').length + padding;
    }
}

async function getSourceContextSize() {
    const overrideLength = extension_settings.synopsis.overrideResponseLength;
    try {
        if (extension_settings.synopsis.source === synopsis_sources.webllm) {
            const maxContext = await getWebLlmContextSize();
            return overrideLength > 0 ? (maxContext - overrideLength) : Math.round(maxContext * 0.75);
        }
        return getMaxContextSize(overrideLength);
    } catch {
        // 兜底
        return 2048;
    }
}

async function buildScriptwriterPrompt() {
    const context = safeGetContext();
    const userDemand = extension_settings.synopsis.userDemand ||
        `a story development that fits ${context.name2 || 'the character'}'s personality`;

    // 拼装历史引用，使用 token 预算裁剪
    let oldSynopsisReference = '';
    const historyToUse = Math.max(0, extension_settings.synopsis.historyCount);
    if (historyToUse > 0 && synopsisHistory.length > 0) {
        const budgetTokens = Math.floor((await getSourceContextSize()) * 0.2); // 历史预算 20%
        let used = 0;
        const selected = [];
        for (const h of synopsisHistory.slice(0, historyToUse)) {
            const t = await countSourceTokens(h.content);
            if (used + t > budgetTokens) break;
            used += t;
            selected.push(h);
        }
        if (selected.length) {
            const historyText = selected
                .map((h, i) => `Previous Synopsis #${i + 1}: ${h.content}`)
                .join('\n');
            oldSynopsisReference = `These are the previous ${selected.length} synopsis(es) for reference:\n${historyText}`;
        }
    }

    const prompt = substituteParamsExtended(
        extension_settings.synopsis.scriptwriterPrompt,
        {
            user_demand: userDemand,
            old_synopsis_reference: oldSynopsisReference,
            char: context.name2 || 'Character',
            user: context.name1 || 'User',
        }
    );

    return prompt;
}

function disableUiWhileGenerating(disabled) {
    const ids = [
        UI_SELECTORS.generateNow,
        UI_SELECTORS.clear,
        UI_SELECTORS.source,
        UI_SELECTORS.frozen,
        UI_SELECTORS.scriptwriterPrompt,
        UI_SELECTORS.template,
        UI_SELECTORS.depth,
        UI_SELECTORS.role,
        UI_SELECTORS.position,
        UI_SELECTORS.checkEmpty,
        UI_SELECTORS.checkWords,
        UI_SELECTORS.promptWords,
        UI_SELECTORS.historyCount,
        UI_SELECTORS.overrideResponseLength,
        UI_SELECTORS.userDemand,
    ];
    ids.forEach(sel => {
        const $el = $(sel);
        if ($el.length) {
            if ($el.is('input[type="radio"]')) {
                $el.prop('disabled', disabled);
            } else {
                $el.prop('disabled', disabled);
            }
        }
    });
}

function archiveSynopsis(synopsis) {
    if (!synopsis) return;
    const item = {
        id: stableId(),
        content: synopsis,
        timestamp: Date.now(),
        userDemand: extension_settings.synopsis.userDemand,
    };
    synopsisHistory.unshift(item);
    if (synopsisHistory.length > MAX_HISTORY) {
        synopsisHistory = synopsisHistory.slice(0, MAX_HISTORY);
    }
    saveSynopsisData();
    updateHistoryList();
}

// 在新消息中剥离结束标记
function stripEndMarkerFromMessageText(text) {
    const endMarker = '<end of current synopsis>';
    if (!text || typeof text !== 'string') return { text, ended: false };
    if (text.includes(endMarker)) {
        return { text: text.replaceAll(endMarker, ''), ended: true };
    }
    return { text, ended: false };
}

function handleSynopsisEndSideEffects() {
    // 归档并清空
    if (currentSynopsis) {
        archiveSynopsis(currentSynopsis);
    }
    currentSynopsis = '';
    extension_settings.synopsis.userDemand = '';
    saveSynopsisData();
    setSynopsisContext('', false);
    updateSynopsisDisplay();
    toastr.info('Current synopsis has ended!', 'Synopsis Complete');
}

function scanAndCleanRecentMessages() {
    const context = safeGetContext();
    if (!Array.isArray(context.chat) || !context.chat.length) return;

    let endedFound = false;
    // 仅检查最近若干条，避免大循环；这里检查最后 3 条
    const start = Math.max(0, context.chat.length - 3);
    for (let i = start; i < context.chat.length; i++) {
        const msg = context.chat[i];
        if (!msg || !msg.mes) continue;
        const { text, ended } = stripEndMarkerFromMessageText(msg.mes);
        if (ended) {
            endedFound = true;
            msg.mes = text;
        }
    }
    if (endedFound) {
        // 若上下文提供保存方法尝试保存
        const ctx = safeGetContext();
        if (ctx.saveChat && typeof ctx.saveChat === 'function') {
            ctx.saveChat().catch(err => {
                console.error('Failed to save chat after cleaning message:', err);
            });
        }
        handleSynopsisEndSideEffects();
    }
}

function wordsSinceLastSynopsisPoint() {
    const context = safeGetContext();
    let words = 0;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const msg = context.chat[i];
        if (msg?.extra?.synopsisPoint) break;
        if (!msg?.mes) continue;
        // 词数估计：优先 extractAllWords，失败退化为字符数/5
        try {
            words += extractAllWords(msg.mes).length;
        } catch {
            words += Math.ceil((msg.mes || '').length / 5);
        }
    }
    return words;
}

// -------------------- 生成逻辑 --------------------
async function generateSynopsis(force = false) {
    if (inApiCall || extension_settings.synopsis.synopsisFrozen) return;

    const context = safeGetContext();

    // 非强制时按条件触发
    if (!force) {
        if (extension_settings.synopsis.checkEmpty && currentSynopsis) return;

        if (extension_settings.synopsis.checkWords) {
            const w = wordsSinceLastSynopsisPoint();
            if (w < extension_settings.synopsis.promptWords) return;
        }
    }

    // WebLLM 可用性检查
    if (extension_settings.synopsis.source === synopsis_sources.webllm && !isWebLlmSupported()) {
        toastr.warning('WebLLM is not supported in this environment.', 'Synopsis');
        return;
    }

    // 取消上一次请求
    if (abortController) {
        try { abortController.abort(); } catch {}
    }
    abortController = new AbortController();

    try {
        inApiCall = true;
        disableUiWhileGenerating(true);

        const scriptwriterPrompt = await buildScriptwriterPrompt();
        let synopsis = '';

        if (extension_settings.synopsis.source === synopsis_sources.main) {
            synopsis = await generateRaw({
                prompt: scriptwriterPrompt,
                responseLength: extension_settings.synopsis.overrideResponseLength,
                signal: abortController.signal,
            });
        } else {
            const messages = [{ role: 'system', content: scriptwriterPrompt }];
            const params = extension_settings.synopsis.overrideResponseLength > 0
                ? { max_tokens: extension_settings.synopsis.overrideResponseLength }
                : {};
            synopsis = await generateWebLlmChatPrompt(messages, params);
        }

        // 统一后处理：去除显式推理/不必要标签
        synopsis = removeReasoningFromString(String(synopsis || '').trim());

        if (synopsis) {
            currentSynopsis = synopsis;
            saveSynopsisData();
            updateSynopsisDisplay();
            updateHistoryList();
            setSynopsisContext(synopsis, true);

            // 标记当前位置
            if (Array.isArray(context.chat) && context.chat.length > 0) {
                const lastMessage = context.chat[context.chat.length - 1];
                if (lastMessage) {
                    if (!lastMessage.extra) lastMessage.extra = {};
                    lastMessage.extra.synopsisPoint = true;
                }
            }

            toastr.success('New synopsis generated!', 'Synopsis');
        }
    } catch (error) {
        if (error?.name === 'AbortError') {
            console.warn('Synopsis generation aborted.');
        } else {
            console.error('Failed to generate synopsis:', error);
            toastr.error('Failed to generate synopsis', 'Error');
        }
    } finally {
        inApiCall = false;
        disableUiWhileGenerating(false);
    }
}

// -------------------- 设置与加载 --------------------
function loadSettings() {
    ensureSettings();

    // 载入保存的 synopsis 与历史
    if (Array.isArray(extension_settings.synopsis.synopsisHistory)) {
        synopsisHistory = extension_settings.synopsis.synopsisHistory;
    } else {
        synopsisHistory = [];
    }
    if (typeof extension_settings.synopsis.currentSynopsis === 'string') {
        currentSynopsis = extension_settings.synopsis.currentSynopsis;
    } else {
        currentSynopsis = '';
    }

    // 初始化 UI 值
    $(UI_SELECTORS.source).val(extension_settings.synopsis.source).trigger('change');
    $(UI_SELECTORS.frozen).prop('checked', extension_settings.synopsis.synopsisFrozen).trigger('input');
    $(UI_SELECTORS.scriptwriterPrompt).val(extension_settings.synopsis.scriptwriterPrompt).trigger('input');
    $(UI_SELECTORS.template).val(extension_settings.synopsis.template).trigger('input');
    $(UI_SELECTORS.depth).val(extension_settings.synopsis.depth).trigger('input');
    $(UI_SELECTORS.role).val(extension_settings.synopsis.role).trigger('input');
    $(UI_SELECTORS.checkEmpty).prop('checked', extension_settings.synopsis.checkEmpty).trigger('input');
    $(UI_SELECTORS.checkWords).prop('checked', extension_settings.synopsis.checkWords).trigger('input');
    $(UI_SELECTORS.promptWords).val(extension_settings.synopsis.promptWords).trigger('input');
    $(UI_SELECTORS.historyCount).val(extension_settings.synopsis.historyCount).trigger('input');
    $(UI_SELECTORS.overrideResponseLength).val(extension_settings.synopsis.overrideResponseLength).trigger('input');
    $(UI_SELECTORS.userDemand).val(extension_settings.synopsis.userDemand).trigger('input');
    $(`${UI_SELECTORS.position}[value="${extension_settings.synopsis.position}"]`).prop('checked', true).trigger('input');

    updateSynopsisDisplay();
    cloneDefaultsToUserPresetsIfNeeded();
    updatePresetsList();
    updateHistoryList();
    switchSourceControls(extension_settings.synopsis.source);
}

// -------------------- 事件处理（UI） --------------------
function onSynopsisSourceChange(event) {
    extension_settings.synopsis.source = event.target.value;
    switchSourceControls(event.target.value);
    saveSettingsDebounced();
}

function onSynopsisFrozenInput() {
    extension_settings.synopsis.synopsisFrozen = $(this).prop('checked');
    saveSettingsDebounced();
}

function onScriptwriterPromptInput() {
    extension_settings.synopsis.scriptwriterPrompt = $(this).val();
    saveSettingsDebounced();
}

function onTemplateInput() {
    extension_settings.synopsis.template = $(this).val();
    setSynopsisContext(currentSynopsis, true);
    saveSettingsDebounced();
}

function onDepthInput() {
    extension_settings.synopsis.depth = Number($(this).val());
    setSynopsisContext(currentSynopsis, true);
    saveSettingsDebounced();
}

function onRoleInput() {
    extension_settings.synopsis.role = Number($(this).val());
    setSynopsisContext(currentSynopsis, true);
    saveSettingsDebounced();
}

function onPositionChange(e) {
    extension_settings.synopsis.position = e.target.value;
    setSynopsisContext(currentSynopsis, true);
    saveSettingsDebounced();
}

function onCheckEmptyInput() {
    extension_settings.synopsis.checkEmpty = $(this).prop('checked');
    saveSettingsDebounced();
}

function onCheckWordsInput() {
    extension_settings.synopsis.checkWords = $(this).prop('checked');
    saveSettingsDebounced();
}

function onPromptWordsInput() {
    extension_settings.synopsis.promptWords = Number($(this).val());
    $(UI_SELECTORS.promptWordsValue).text(extension_settings.synopsis.promptWords);
    saveSettingsDebounced();
}

function onHistoryCountInput() {
    extension_settings.synopsis.historyCount = Number($(this).val());
    $(UI_SELECTORS.historyCountValue).text(extension_settings.synopsis.historyCount);
    saveSettingsDebounced();
}

function onOverrideResponseLengthInput() {
    extension_settings.synopsis.overrideResponseLength = Number($(this).val());
    $(UI_SELECTORS.overrideResponseLengthValue).text(extension_settings.synopsis.overrideResponseLength);
    saveSettingsDebounced();
}

function onUserDemandInput() {
    extension_settings.synopsis.userDemand = $(this).val();
    saveSettingsDebounced();
}

function onCurrentSynopsisInput() {
    currentSynopsis = $(this).val();
    setSynopsisContext(currentSynopsis, true);
    updateSynopsisDisplay();
}

function onHistorySelectChange() {
    const value = $(this).val();
    if (value === 'current') {
        $(UI_SELECTORS.historyContent).val(currentSynopsis);
        return;
    }
    const item = synopsisHistory.find(h => h.id === value);
    $(UI_SELECTORS.historyContent).val(item ? item.content : '');
}

function onHistoryDelete() {
    const value = $(UI_SELECTORS.historySelect).val();
    if (value && value !== 'current') {
        const item = synopsisHistory.find(h => h.id === value);
        if (item && confirm('Delete this synopsis from history?')) {
            synopsisHistory = synopsisHistory.filter(h => h.id !== value);
            saveSynopsisData();
            updateHistoryList();
            $(UI_SELECTORS.historyContent).val('');
            toastr.success('Synopsis deleted!');
        }
    }
}

function onHistorySave() {
    const value = $(UI_SELECTORS.historySelect).val();
    const content = $(UI_SELECTORS.historyContent).val();
    if (value === 'current') {
        currentSynopsis = content;
        setSynopsisContext(currentSynopsis, true);
        updateSynopsisDisplay();
        toastr.success('Current synopsis saved!');
    } else {
        const item = synopsisHistory.find(h => h.id === value);
        if (item) {
            item.content = content;
            saveSynopsisData();
            toastr.success('History synopsis saved!');
        }
    }
}

function onPresetApply() {
    const selected = $(UI_SELECTORS.presetSelect).val();
    cloneDefaultsToUserPresetsIfNeeded();
    if (selected && selected !== '__custom__') {
        const presets = extension_settings.synopsis.presets || {};
        if (presets[selected]) {
            $(UI_SELECTORS.userDemand).val(presets[selected]).trigger('input');
        }
    } else if (selected === '__custom__') {
        const name = prompt('Enter preset name:');
        if (name) {
            const content = $(UI_SELECTORS.userDemand).val();
            cloneDefaultsToUserPresetsIfNeeded();
            extension_settings.synopsis.presets[name] = content;
            saveSettingsDebounced();
            updatePresetsList();
            $(UI_SELECTORS.presetSelect).val(name);
            toastr.success(`Preset "${name}" saved!`);
        }
    }
}

function onPresetStore() {
    const content = $(UI_SELECTORS.userDemand).val();
    const name = prompt('Save current input as preset with name:', 'Custom Preset');
    if (name) {
        cloneDefaultsToUserPresetsIfNeeded();
        extension_settings.synopsis.presets[name] = content;
        saveSettingsDebounced();
        updatePresetsList();
        toastr.success(`Preset "${name}" saved!`);
    }
}

function onPresetDelete() {
    const selected = $(UI_SELECTORS.presetSelect).val();
    if (selected && selected !== '__custom__' && selected !== '') {
        if (confirm(`Delete preset "${selected}"?`)) {
            cloneDefaultsToUserPresetsIfNeeded();
            if (extension_settings.synopsis.presets[selected] !== undefined) {
                delete extension_settings.synopsis.presets[selected];
                saveSettingsDebounced();
                updatePresetsList();
                toastr.success(`Preset "${selected}" deleted!`);
            } else {
                toastr.info('This preset is not in user space and cannot be deleted directly.');
            }
        }
    }
}

// -------------------- 聊天事件 --------------------
async function onChatEvent() {
    // WebLLM 环境检查
    if (extension_settings.synopsis.source === synopsis_sources.webllm && !isWebLlmSupported()) {
        return;
    }

    // 避免在流式未完成时触发
    if (streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    // 优先清理消息中的结束标记
    scanAndCleanRecentMessages();

    if (inApiCall || extension_settings.synopsis.synopsisFrozen) {
        return;
    }

    // 在角色消息渲染后，按配置尝试触发生成（非强制）
    await generateSynopsis(false);
}

async function onUserMessageBefore() {
    // 发送前若为空且未冻结，强制生成
    if (extension_settings.synopsis.checkEmpty && !currentSynopsis && !extension_settings.synopsis.synopsisFrozen) {
        await generateSynopsis(true);
    }
}

// -------------------- UI 绑定 --------------------
function setupListeners() {
    $(UI_SELECTORS.source).off('change').on('change', onSynopsisSourceChange);
    $(UI_SELECTORS.frozen).off('input').on('input', onSynopsisFrozenInput);
    $(UI_SELECTORS.scriptwriterPrompt).off('input').on('input', onScriptwriterPromptInput);
    $(UI_SELECTORS.template).off('input').on('input', onTemplateInput);
    $(UI_SELECTORS.depth).off('input').on('input', onDepthInput);
    $(UI_SELECTORS.role).off('input').on('input', onRoleInput);
    $(UI_SELECTORS.position).off('change').on('change', onPositionChange);
    $(UI_SELECTORS.checkEmpty).off('input').on('input', onCheckEmptyInput);
    $(UI_SELECTORS.checkWords).off('input').on('input', onCheckWordsInput);
    $(UI_SELECTORS.promptWords).off('input').on('input', onPromptWordsInput);
    $(UI_SELECTORS.historyCount).off('input').on('input', onHistoryCountInput);
    $(UI_SELECTORS.overrideResponseLength).off('input').on('input', onOverrideResponseLengthInput);
    $(UI_SELECTORS.userDemand).off('input').on('input', onUserDemandInput);
    $(UI_SELECTORS.current).off('input').on('input', onCurrentSynopsisInput);

    $(UI_SELECTORS.generateNow).off('click').on('click', () => generateSynopsis(true));
    $(UI_SELECTORS.clear).off('click').on('click', () => {
        currentSynopsis = '';
        setSynopsisContext('', true);
        updateSynopsisDisplay();
    });

    $(UI_SELECTORS.historySelect).off('change').on('change', onHistorySelectChange);
    $(UI_SELECTORS.historyDelete).off('click').on('click', onHistoryDelete);
    $(UI_SELECTORS.historySave).off('click').on('click', onHistorySave);

    $(UI_SELECTORS.presetApply).off('click').on('click', onPresetApply);
    $(UI_SELECTORS.presetStore).off('click').on('click', onPresetStore);
    $(UI_SELECTORS.presetDelete).off('click').on('click', onPresetDelete);

    $(UI_SELECTORS.scriptwriterRestore).off('click').on('click', () => {
        if (confirm('Restore default scriptwriter prompt? This will overwrite current content.')) {
            $(UI_SELECTORS.scriptwriterPrompt).val(defaultScriptwriterPrompt).trigger('input');
        }
    });
    $(UI_SELECTORS.templateRestore).off('click').on('click', () => {
        if (confirm('Restore default template? This will overwrite current content.')) {
            $(UI_SELECTORS.template).val(defaultTemplate).trigger('input');
        }
    });
}

// -------------------- Slash 命令 --------------------
async function synopsisCallback(args, text) {
    const action = args.action || 'get';
    switch (action) {
        case 'get':
            return currentSynopsis || '';
        case 'generate':
            await generateSynopsis(true);
            return currentSynopsis || '';
        case 'clear':
            currentSynopsis = '';
            setSynopsisContext('', true);
            updateSynopsisDisplay();
            return 'Synopsis cleared';
        case 'set':
            if (text) {
                currentSynopsis = text;
                setSynopsisContext(currentSynopsis, true);
                updateSynopsisDisplay();
                return 'Synopsis updated';
            }
            return 'No text provided';
        default:
            return 'Unknown action';
    }
}

// -------------------- 初始化 --------------------
jQuery(async function () {
    async function addExtensionControls() {
        const settingsHtml = await renderExtensionTemplateAsync('synopsis', 'settings', { defaultSettings });
        const $mount = $(UI_SELECTORS.settingsMount);
        if ($mount.length) {
            $mount.append(settingsHtml);
            setupListeners();
        } else {
            console.warn('Settings mount point not found:', UI_SELECTORS.settingsMount);
        }
    }

    await addExtensionControls();
    loadSettings();

    // 注册事件监听
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    eventSource.on(event_types.USER_MESSAGE_BEFORE_SEND, onUserMessageBefore);

    // 注册 slash 命令
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'synopsis',
        callback: synopsisCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument('action', 'Action to perform (get, generate, clear, set)', [ARGUMENT_TYPE.STRING], false, false, 'get', ['get', 'generate', 'clear', 'set']),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text for set action', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Manage story synopsis. Actions: get (default), generate, clear, set [text]',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // 注册宏
    MacrosParser.registerMacro('synopsis', () => currentSynopsis || '');
});