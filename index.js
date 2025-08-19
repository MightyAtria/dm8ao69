import { getStringHash, debounce, waitUntilCondition, extractAllWords, isTrueBoolean } from '../../utils.js';
import { getContext, getApiUrl, extension_settings, doExtrasFetch, modules, renderExtensionTemplateAsync } from '../../extensions.js';
import {
    activateSendButtons,
    deactivateSendButtons,
    animation_duration,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    is_send_press,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxContextSize,
    setExtensionPrompt,
    streamingProcessor,
    animation_easing,
} from '../../../script.js';
import { is_group_generating, selected_group } from '../../group-chats.js';
import { loadMovingUIState } from '../../power-user.js';
import { dragElement } from '../../RossAscends-mods.js';
import { getTextTokens, getTokenCountAsync, tokenizers } from '../../tokenizers.js';
import { debounce_timeout } from '../../constants.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { MacrosParser } from '../../macros.js';
import { countWebLlmTokens, generateWebLlmChatPrompt, getWebLlmContextSize, isWebLlmSupported } from '../shared.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { removeReasoningFromString } from '../../reasoning.js';
export { MODULE_NAME };

const MODULE_NAME = '2_synopsis';

let lastMessageHash = null;
let lastMessageId = null;
let inApiCall = false;

/**
 * Count the number of tokens in the provided text.
 * @param {string} text Text to count tokens for
 * @param {number} padding Number of additional tokens to add to the count
 * @returns {Promise<number>} Number of tokens in the text
 */
async function countSourceTokens(text, padding = 0) {
    if (extension_settings.synopsis.source === synopsis_sources.webllm) {
        const count = await countWebLlmTokens(text);
        return count + padding;
    }

    if (extension_settings.synopsis.source === synopsis_sources.extras) {
        const count = getTextTokens(tokenizers.GPT2, text).length;
        return count + padding;
    }

    return await getTokenCountAsync(text, padding);
}

async function getSourceContextSize() {
    const overrideLength = extension_settings.synopsis.overrideResponseLength;

    if (extension_settings.synopsis.source === synopsis_sources.webllm) {
        const maxContext = await getWebLlmContextSize();
        return overrideLength > 0 ? (maxContext - overrideLength) : Math.round(maxContext * 0.75);
    }

    if (extension_settings.source === synopsis_sources.extras) {
        return 1024 - 64;
    }

    return getMaxContextSize(overrideLength);
}

const formatSynopsisValue = function (value) {
    if (!value) {
        return '';
    }

    value = value.trim();

    if (extension_settings.synopsis.template) {
        return substituteParamsExtended(extension_settings.synopsis.template, { synopsis: value });
    } else {
        return `Synopsis: ${value}`;
    }
};

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

const synopsis_sources = {
    'extras': 'extras',
    'main': 'main',
    'webllm': 'webllm',
};

const prompt_builders = {
    DEFAULT: 0,
    RAW_BLOCKING: 1,
    RAW_NON_BLOCKING: 2,
};

const defaultPrompt = 'Ignore previous instructions. Summarize the most important facts and events in the story so far. If a synopsis already exists in your memory, use that as a base and expand with new facts. Limit the synopsis to {{words}} words or less. Your response should include nothing but the synopsis.';
const defaultTemplate = '[Synopsis: {{synopsis}}]';

const defaultSettings = {
    synopsisFrozen: false,
    SkipWIAN: false,
    source: synopsis_sources.extras,
    prompt: defaultPrompt,
    template: defaultTemplate,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    scan: false,
    depth: 2,
    promptWords: 200,
    promptMinWords: 25,
    promptMaxWords: 1000,
    promptWordsStep: 25,
    promptInterval: 10,
    promptMinInterval: 0,
    promptMaxInterval: 250,
    promptIntervalStep: 1,
    promptForceWords: 0,
    promptForceWordsStep: 100,
    promptMinForceWords: 0,
    promptMaxForceWords: 10000,
    overrideResponseLength: 0,
    overrideResponseLengthMin: 0,
    overrideResponseLengthMax: 4096,
    overrideResponseLengthStep: 16,
    maxMessagesPerRequest: 0,
    maxMessagesPerRequestMin: 0,
    maxMessagesPerRequestMax: 250,
    maxMessagesPerRequestStep: 1,
    prompt_builder: prompt_builders.DEFAULT,
};

function loadSettings() {
    if (Object.keys(extension_settings.synopsis).length === 0) {
        Object.assign(extension_settings.synopsis, defaultSettings);
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings.synopsis[key] === undefined) {
            extension_settings.synopsis[key] = defaultSettings[key];
        }
    }

    $('#synopsis_source').val(extension_settings.synopsis.source).trigger('change');
    $('#synopsis_frozen').prop('checked', extension_settings.synopsis.synopsisFrozen).trigger('input');
    $('#synopsis_skipWIAN').prop('checked', extension_settings.synopsis.SkipWIAN).trigger('input');
    $('#synopsis_prompt').val(extension_settings.synopsis.prompt).trigger('input');
    $('#synopsis_prompt_words').val(extension_settings.synopsis.promptWords).trigger('input');
    $('#synopsis_prompt_interval').val(extension_settings.synopsis.promptInterval).trigger('input');
    $('#synopsis_template').val(extension_settings.synopsis.template).trigger('input');
    $('#synopsis_depth').val(extension_settings.synopsis.depth).trigger('input');
    $('#synopsis_role').val(extension_settings.synopsis.role).trigger('input');
    $(`input[name="synopsis_position"][value="${extension_settings.synopsis.position}"]`).prop('checked', true).trigger('input');
    $('#synopsis_prompt_words_force').val(extension_settings.synopsis.promptForceWords).trigger('input');
    $(`input[name="synopsis_prompt_builder"][value="${extension_settings.synopsis.prompt_builder}"]`).prop('checked', true).trigger('input');
    $('#synopsis_override_response_length').val(extension_settings.synopsis.overrideResponseLength).trigger('input');
    $('#synopsis_max_messages_per_request').val(extension_settings.synopsis.maxMessagesPerRequest).trigger('input');
    $('#synopsis_include_wi_scan').prop('checked', extension_settings.synopsis.scan).trigger('input');
    switchSourceControls(extension_settings.synopsis.source);
}

async function onPromptForceWordsAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const averageMessageWordCount = messagesWordCount / allMessages.length;
    const tokensPerWord = await countSourceTokens(allMessages.join('\n')) / messagesWordCount;
    const wordsPerToken = 1 / tokensPerWord;
    const maxPromptLengthWords = Math.round(maxPromptLength * wordsPerToken);
    // How many words should pass so that messages will start be dropped out of context;
    const wordsPerPrompt = Math.floor(maxPromptLength / tokensPerWord);
    // How many words will be needed to fit the allowance buffer
    const synopsisPromptWords = extractAllWords(extension_settings.synopsis.prompt).length;
    const promptAllowanceWords = maxPromptLengthWords - extension_settings.synopsis.promptWords - synopsisPromptWords;
    const averageMessagesPerPrompt = Math.floor(promptAllowanceWords / averageMessageWordCount);
    const maxMessagesPerSynopsis = extension_settings.synopsis.maxMessagesPerRequest || 0;
    const targetMessagesInPrompt = maxMessagesPerSynopsis > 0 ? maxMessagesPerSynopsis : Math.max(0, averageMessagesPerPrompt);
    const targetSynopsisWords = (targetMessagesInPrompt * averageMessageWordCount) + (promptAllowanceWords / 4);

    console.table({
        maxPromptLength,
        maxPromptLengthWords,
        promptAllowanceWords,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        targetSynopsisWords,
        wordsPerPrompt,
        wordsPerToken,
        tokensPerWord,
        messagesWordCount,
    });

    const ROUNDING = 100;
    extension_settings.synopsis.promptForceWords = Math.max(1, Math.floor(targetSynopsisWords / ROUNDING) * ROUNDING);
    $('#synopsis_prompt_words_force').val(extension_settings.synopsis.promptForceWords).trigger('input');
}

async function onPromptIntervalAutoClick() {
    const context = getContext();
    const maxPromptLength = await getSourceContextSize();
    const chat = context.chat;
    const allMessages = chat.filter(m => !m.is_system && m.mes).map(m => m.mes);
    const messagesWordCount = allMessages.map(m => extractAllWords(m)).flat().length;
    const messagesTokenCount = await countSourceTokens(allMessages.join('\n'));
    const tokensPerWord = messagesTokenCount / messagesWordCount;
    const averageMessageTokenCount = messagesTokenCount / allMessages.length;
    const targetSynopsisTokens = Math.round(extension_settings.synopsis.promptWords * tokensPerWord);
    const promptTokens = await countSourceTokens(extension_settings.synopsis.prompt);
    const promptAllowance = maxPromptLength - promptTokens - targetSynopsisTokens;
    const maxMessagesPerSynopsis = extension_settings.synopsis.maxMessagesPerRequest || 0;
    const averageMessagesPerPrompt = Math.floor(promptAllowance / averageMessageTokenCount);
    const targetMessagesInPrompt = maxMessagesPerSynopsis > 0 ? maxMessagesPerSynopsis : Math.max(0, averageMessagesPerPrompt);
    const adjustedAverageMessagesPerPrompt = targetMessagesInPrompt + (averageMessagesPerPrompt - targetMessagesInPrompt) / 4;

    console.table({
        maxPromptLength,
        promptAllowance,
        targetSynopsisTokens,
        promptTokens,
        messagesWordCount,
        messagesTokenCount,
        tokensPerWord,
        averageMessageTokenCount,
        averageMessagesPerPrompt,
        targetMessagesInPrompt,
        adjustedAverageMessagesPerPrompt,
        maxMessagesPerSynopsis,
    });

    const ROUNDING = 5;
    extension_settings.synopsis.promptInterval = Math.max(1, Math.floor(adjustedAverageMessagesPerPrompt / ROUNDING) * ROUNDING);

    $('#synopsis_prompt_interval').val(extension_settings.synopsis.promptInterval).trigger('input');
}

function onSynopsisSourceChange(event) {
    const value = event.target.value;
    extension_settings.synopsis.source = value;
    switchSourceControls(value);
    saveSettingsDebounced();
}

function switchSourceControls(value) {
    $('#synopsisExtensionDrawerContents [data-synopsis-source], #synopsis_settings [data-synopsis-source]').each((_, element) => {
        const source = element.dataset.synopsisSource.split(',').map(s => s.trim());
        $(element).toggle(source.includes(value));
    });
}

function onSynopsisFrozenInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings.synopsis.synopsisFrozen = value;
    saveSettingsDebounced();
}

function onSynopsisSkipWIANInput() {
    const value = Boolean($(this).prop('checked'));
    extension_settings.synopsis.SkipWIAN = value;
    saveSettingsDebounced();
}

function onSynopsisPromptWordsInput() {
    const value = $(this).val();
    extension_settings.synopsis.promptWords = Number(value);
    $('#synopsis_prompt_words_value').text(extension_settings.synopsis.promptWords);
    saveSettingsDebounced();
}

function onSynopsisPromptIntervalInput() {
    const value = $(this).val();
    extension_settings.synopsis.promptInterval = Number(value);
    $('#synopsis_prompt_interval_value').text(extension_settings.synopsis.promptInterval);
    saveSettingsDebounced();
}

function onSynopsisPromptRestoreClick() {
    $('#synopsis_prompt').val(defaultPrompt).trigger('input');
}

function onSynopsisPromptInput() {
    const value = $(this).val();
    extension_settings.synopsis.prompt = value;
    saveSettingsDebounced();
}

function onSynopsisTemplateInput() {
    const value = $(this).val();
    extension_settings.synopsis.template = value;
    reinsertSynopsis();
    saveSettingsDebounced();
}

function onSynopsisDepthInput() {
    const value = $(this).val();
    extension_settings.synopsis.depth = Number(value);
    reinsertSynopsis();
    saveSettingsDebounced();
}

function onSynopsisRoleInput() {
    const value = $(this).val();
    extension_settings.synopsis.role = Number(value);
    reinsertSynopsis();
    saveSettingsDebounced();
}

function onSynopsisPositionChange(e) {
    const value = e.target.value;
    extension_settings.synopsis.position = value;
    reinsertSynopsis();
    saveSettingsDebounced();
}

function onSynopsisIncludeWIScanInput() {
    const value = !!$(this).prop('checked');
    extension_settings.synopsis.scan = value;
    reinsertSynopsis();
    saveSettingsDebounced();
}

function onSynopsisPromptWordsForceInput() {
    const value = $(this).val();
    extension_settings.synopsis.promptForceWords = Number(value);
    $('#synopsis_prompt_words_force_value').text(extension_settings.synopsis.promptForceWords);
    saveSettingsDebounced();
}

function onOverrideResponseLengthInput() {
    const value = $(this).val();
    extension_settings.synopsis.overrideResponseLength = Number(value);
    $('#synopsis_override_response_length_value').text(extension_settings.synopsis.overrideResponseLength);
    saveSettingsDebounced();
}

function onMaxMessagesPerRequestInput() {
    const value = $(this).val();
    extension_settings.synopsis.maxMessagesPerRequest = Number(value);
    $('#synopsis_max_messages_per_request_value').text(extension_settings.synopsis.maxMessagesPerRequest);
    saveSettingsDebounced();
}

function getLatestSynopsisFromChat(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return '';
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.synopsis) {
            return mes.extra.synopsis;
        }
    }

    return '';
}

function getIndexOfLatestChatSynopsis(chat) {
    if (!Array.isArray(chat) || !chat.length) {
        return -1;
    }

    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.synopsis) {
            return chat.indexOf(mes);
        }
    }

    return -1;
}

/**
 * Check if something is changed during the summarization process.
 * @param {{ groupId: any; chatId: any; characterId: any; }} context
 * @returns {boolean} True if the context has changed and the synopsis should be discarded
 */
function isContextChanged(context) {
    const newContext = getContext();
    if (newContext.groupId !== context.groupId
        || newContext.chatId !== context.chatId
        || (!newContext.groupId && (newContext.characterId !== context.characterId))) {
        console.log('Context changed, synopsis discarded');
        return true;
    }

    return false;
}

function onChatChanged() {
    const context = getContext();
    const latestSynopsis = getLatestSynopsisFromChat(context.chat);
    setSynopsisContext(latestSynopsis, false);
}

async function onChatEvent() {
    // Module not enabled
    if (extension_settings.synopsis.source === synopsis_sources.extras && !modules.includes('summarize')) {
        return;
    }

    // WebLLM is not supported
    if (extension_settings.synopsis.source === synopsis_sources.webllm && !isWebLlmSupported()) {
        return;
    }

    // Streaming in-progress
    if (streamingProcessor && !streamingProcessor.isFinished) {
        return;
    }

    // Currently summarizing or frozen state - skip
    if (inApiCall || extension_settings.synopsis.synopsisFrozen) {
        return;
    }

    const context = getContext();
    const chat = context.chat;

    // No new messages - do nothing
    if (chat.length === 0 || (lastMessageId === chat.length && getStringHash(chat[chat.length - 1].mes) === lastMessageHash)) {
        return;
    }

    // Messages has been deleted - rewrite the context with the latest available synopsis
    if (chat.length < lastMessageId) {
        const latestSynopsis = getLatestSynopsisFromChat(chat);
        setSynopsisContext(latestSynopsis, false);
    }

    // Message has been edited / regenerated - delete the saved synopsis
    if (chat.length
        && chat[chat.length - 1].extra
        && chat[chat.length - 1].extra.synopsis
        && lastMessageId === chat.length
        && getStringHash(chat[chat.length - 1].mes) !== lastMessageHash) {
        delete chat[chat.length - 1].extra.synopsis;
    }

    summarizeChat(context)
        .catch(console.error)
        .finally(() => {
            lastMessageId = context.chat?.length ?? null;
            lastMessageHash = getStringHash((context.chat.length && context.chat[context.chat.length - 1]['mes']) ?? '');
        });
}

/**
 * Forces a synopsis generation for the current chat.
 * @param {boolean} quiet If an informational toast should be displayed
 * @returns {Promise<string>} Summarized text
 */
async function forceSummarizeChat(quiet) {
    if (extension_settings.synopsis.source === synopsis_sources.extras) {
        toastr.warning('Force summarization is not supported for Extras API');
        return;
    }

    const context = getContext();
    const skipWIAN = extension_settings.synopsis.SkipWIAN;

    const toast = quiet ? jQuery() : toastr.info('Summarizing chat...', 'Please wait', { timeOut: 0, extendedTimeOut: 0 });
    const value = extension_settings.synopsis.source === synopsis_sources.main
        ? await summarizeChatMain(context, true, skipWIAN)
        : await summarizeChatWebLLM(context, true);

    toastr.clear(toast);

    if (!value) {
        toastr.warning('Failed to summarize chat');
        return '';
    }

    return value;
}

/**
 * Callback for the makesynopsis command.
 * @param {object} args Command arguments
 * @param {string} text Text to summarize
 */
async function makesynopsisCallback(args, text) {
    text = text.trim();

    // Summarize the current chat if no text provided
    if (!text) {
        const quiet = isTrueBoolean(args.quiet);
        return await forceSummarizeChat(quiet);
    }

    const source = args.source || extension_settings.synopsis.source;
    const prompt = substituteParamsExtended((args.prompt || extension_settings.synopsis.prompt), { words: extension_settings.synopsis.promptWords });

    try {
        switch (source) {
            case synopsis_sources.extras:
                return await callExtrasSummarizeAPI(text);
            case synopsis_sources.main:
                return removeReasoningFromString(await generateRaw({ prompt: text, systemPrompt: prompt, responseLength: extension_settings.synopsis.overrideResponseLength }));
            case synopsis_sources.webllm: {
                const messages = [{ role: 'system', content: prompt }, { role: 'user', content: text }].filter(m => m.content);
                const params = extension_settings.synopsis.overrideResponseLength > 0 ? { max_tokens: extension_settings.synopsis.overrideResponseLength } : {};
                return await generateWebLlmChatPrompt(messages, params);
            }
            default:
                toastr.warning('Invalid summarization source specified');
                return '';
        }
    } catch (error) {
        toastr.error(String(error), 'Failed to summarize text');
        console.log(error);
        return '';
    }
}

async function summarizeChat(context) {
    const skipWIAN = extension_settings.synopsis.SkipWIAN;
    switch (extension_settings.synopsis.source) {
        case synopsis_sources.extras:
            await summarizeChatExtras(context);
            break;
        case synopsis_sources.main:
            await summarizeChatMain(context, false, skipWIAN);
            break;
        case synopsis_sources.webllm:
            await summarizeChatWebLLM(context, false);
            break;
        default:
            break;
    }
}

/**
 * Check if the chat should be summarized based on the current conditions.
 * Return synopsis prompt if it should be summarized.
 * @param {any} context ST context
 * @param {boolean} force Summarize the chat regardless of the conditions
 * @returns {Promise<string>} Synopsis prompt or empty string
 */
async function getSynopsisPromptForNow(context, force) {
    if (extension_settings.synopsis.promptInterval === 0 && !force) {
        console.debug('Prompt interval is set to 0, skipping summarization');
        return '';
    }

    try {
        // Wait for group to finish generating
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        // Wait for the send button to be released
        await waitUntilCondition(() => is_send_press === false, 30000, 100);
    } catch {
        console.debug('Timeout waiting for is_send_press');
        return '';
    }

    if (!context.chat.length) {
        console.debug('No messages in chat to summarize');
        return '';
    }

    if (context.chat.length < extension_settings.synopsis.promptInterval && !force) {
        console.debug(`Not enough messages in chat to summarize (chat: ${context.chat.length}, interval: ${extension_settings.synopsis.promptInterval})`);
        return '';
    }

    let messagesSinceLastSynopsis = 0;
    let wordsSinceLastSynopsis = 0;
    let conditionSatisfied = false;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].extra && context.chat[i].extra.synopsis) {
            break;
        }
        messagesSinceLastSynopsis++;
        wordsSinceLastSynopsis += extractAllWords(context.chat[i].mes).length;
    }

    if (messagesSinceLastSynopsis >= extension_settings.synopsis.promptInterval) {
        conditionSatisfied = true;
    }

    if (extension_settings.synopsis.promptForceWords && wordsSinceLastSynopsis >= extension_settings.synopsis.promptForceWords) {
        conditionSatisfied = true;
    }

    if (!conditionSatisfied && !force) {
        console.debug(`Synopsis conditions not satisfied (messages: ${messagesSinceLastSynopsis}, interval: ${extension_settings.synopsis.promptInterval}, words: ${wordsSinceLastSynopsis}, force words: ${extension_settings.synopsis.promptForceWords})`);
        return '';
    }

    console.log('Summarizing chat, messages since last synopsis: ' + messagesSinceLastSynopsis, 'words since last synopsis: ' + wordsSinceLastSynopsis);
    const prompt = substituteParamsExtended(extension_settings.synopsis.prompt, { words: extension_settings.synopsis.promptWords });

    if (!prompt) {
        console.debug('Summarization prompt is empty. Skipping summarization.');
        return '';
    }

    return prompt;
}

async function summarizeChatWebLLM(context, force) {
    if (!isWebLlmSupported()) {
        return;
    }

    const prompt = await getSynopsisPromptForNow(context, force);

    if (!prompt) {
        return;
    }

    const { rawPrompt, lastUsedIndex } = await getRawSynopsisPrompt(context, prompt);

    if (lastUsedIndex === null || lastUsedIndex === -1) {
        if (force) {
            toastr.info('To try again, remove the latest synopsis.', 'No messages found to summarize');
        }

        return null;
    }

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: rawPrompt },
    ];

    const params = {};

    if (extension_settings.synopsis.overrideResponseLength > 0) {
        params.max_tokens = extension_settings.synopsis.overrideResponseLength;
    }

    try {
        inApiCall = true;
        const synopsis = await generateWebLlmChatPrompt(messages, params);

        if (!synopsis) {
            console.warn('Empty synopsis received');
            return;
        }

        // something changed during summarization request
        if (isContextChanged(context)) {
            return;
        }

        setSynopsisContext(synopsis, true, lastUsedIndex);
        return synopsis;
    } finally {
        inApiCall = false;
    }
}

async function summarizeChatMain(context, force, skipWIAN) {
    const prompt = await getSynopsisPromptForNow(context, force);

    if (!prompt) {
        return;
    }

    console.log('sending synopsis prompt');
    let synopsis = '';
    let index = null;

    if (prompt_builders.DEFAULT === extension_settings.synopsis.prompt_builder) {
        try {
            inApiCall = true;
            /** @type {import('../../../script.js').GenerateQuietPromptParams} */
            const params = {
                quietPrompt: prompt,
                skipWIAN: skipWIAN,
                responseLength: extension_settings.synopsis.overrideResponseLength,
            };
            synopsis = await generateQuietPrompt(params);
        } finally {
            inApiCall = false;
        }
    }

    if ([prompt_builders.RAW_BLOCKING, prompt_builders.RAW_NON_BLOCKING].includes(extension_settings.synopsis.prompt_builder)) {
        const lock = extension_settings.synopsis.prompt_builder === prompt_builders.RAW_BLOCKING;
        try {
            inApiCall = true;
            if (lock) {
                deactivateSendButtons();
            }

            const { rawPrompt, lastUsedIndex } = await getRawSynopsisPrompt(context, prompt);

            if (lastUsedIndex === null || lastUsedIndex === -1) {
                if (force) {
                    toastr.info('To try again, remove the latest synopsis.', 'No messages found to summarize');
                }

                return null;
            }

            /** @type {import('../../../script.js').GenerateRawParams} */
            const params = {
                prompt: rawPrompt,
                systemPrompt: prompt,
                responseLength: extension_settings.synopsis.overrideResponseLength,
            };
            const rawSynopsis = await generateRaw(params);
            synopsis = removeReasoningFromString(rawSynopsis);
            index = lastUsedIndex;
        } finally {
            inApiCall = false;
            if (lock) {
                activateSendButtons();
            }
        }
    }

    if (!synopsis) {
        console.warn('Empty synopsis received');
        return;
    }

    if (isContextChanged(context)) {
        return;
    }

    setSynopsisContext(synopsis, true, index);
    return synopsis;
}

/**
 * Get the raw summarization prompt from the chat context.
 * @param {object} context ST context
 * @param {string} prompt Summarization system prompt
 * @returns {Promise<{rawPrompt: string, lastUsedIndex: number}>} Raw summarization prompt
 */
async function getRawSynopsisPrompt(context, prompt) {
    /**
     * Get the synopsis string from the chat buffer.
     * @param {boolean} includeSystem Include prompt into the synopsis string
     * @returns {string} Synopsis string
     */
    function getSynopsisString(includeSystem) {
        const delimiter = '\n\n';
        const stringBuilder = [];
        const bufferString = chatBuffer.slice().join(delimiter);

        if (includeSystem) {
            stringBuilder.push(prompt);
        }

        if (latestSynopsis) {
            stringBuilder.push(latestSynopsis);
        }

        stringBuilder.push(bufferString);

        return stringBuilder.join(delimiter).trim();
    }

    const chat = context.chat.slice();
    const latestSynopsis = getLatestSynopsisFromChat(chat);
    const latestSynopsisIndex = getIndexOfLatestChatSynopsis(chat);
    chat.pop(); // We always exclude the last message from the buffer
    const chatBuffer = [];
    const PADDING = 64;
    const PROMPT_SIZE = await getSourceContextSize();
    let latestUsedMessage = null;

    for (let index = latestSynopsisIndex + 1; index < chat.length; index++) {
        const message = chat[index];

        if (!message) {
            break;
        }

        if (message.is_system || !message.mes) {
            continue;
        }

        const entry = `${message.name}:\n${message.mes}`;
        chatBuffer.push(entry);

        const tokens = await countSourceTokens(getSynopsisString(true), PADDING);

        if (tokens > PROMPT_SIZE) {
            chatBuffer.pop();
            break;
        }

        latestUsedMessage = message;

        if (extension_settings.synopsis.maxMessagesPerRequest > 0 && chatBuffer.length >= extension_settings.synopsis.maxMessagesPerRequest) {
            break;
        }
    }

    const lastUsedIndex = context.chat.indexOf(latestUsedMessage);
    const rawPrompt = getSynopsisString(false);
    return { rawPrompt, lastUsedIndex };
}

async function summarizeChatExtras(context) {
    function getSynopsisString() {
        return (longSynopsis + '\n\n' + synopsisBuffer.slice().reverse().join('\n\n')).trim();
    }

    const chat = context.chat;
    const longSynopsis = getLatestSynopsisFromChat(chat);
    const reversedChat = chat.slice().reverse();
    reversedChat.shift();
    const synopsisBuffer = [];
    const CONTEXT_SIZE = await getSourceContextSize();

    for (const message of reversedChat) {
        // we reached the point of latest synopsis
        if (longSynopsis && message.extra && message.extra.synopsis == longSynopsis) {
            break;
        }

        // don't care about system
        if (message.is_system) {
            continue;
        }

        // determine the sender's name
        const entry = `${message.name}:\n${message.mes}`;
        synopsisBuffer.push(entry);

        // check if token limit was reached
        const tokens = await countSourceTokens(getSynopsisString());
        if (tokens >= CONTEXT_SIZE) {
            break;
        }
    }

    const resultingString = getSynopsisString();
    const resultingTokens = await countSourceTokens(resultingString);

    if (!resultingString || resultingTokens < CONTEXT_SIZE) {
        console.debug('Not enough context to summarize');
        return;
    }

    // perform the summarization API call
    try {
        inApiCall = true;
        const synopsis = await callExtrasSummarizeAPI(resultingString);

        if (!synopsis) {
            console.warn('Empty synopsis received');
            return;
        }

        if (isContextChanged(context)) {
            return;
        }

        setSynopsisContext(synopsis, true);
    }
    catch (error) {
        console.log(error);
    }
    finally {
        inApiCall = false;
    }
}

/**
 * Call the Extras API to summarize the provided text.
 * @param {string} text Text to summarize
 * @returns {Promise<string>} Summarized text
 */
async function callExtrasSummarizeAPI(text) {
    if (!modules.includes('summarize')) {
        throw new Error('Summarize module is not enabled in Extras API');
    }

    const url = new URL(getApiUrl());
    url.pathname = '/api/summarize';

    const apiResult = await doExtrasFetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Bypass-Tunnel-Reminder': 'bypass',
        },
        body: JSON.stringify({
            text: text,
            params: {},
        }),
    });

    if (apiResult.ok) {
        const data = await apiResult.json();
        const synopsis = data.summary;
        return synopsis;
    }

    throw new Error('Extras API call failed');
}

function onSynopsisRestoreClick() {
    const context = getContext();
    const content = $('#synopsis_contents').val();
    const reversedChat = context.chat.slice().reverse();
    reversedChat.shift();

    for (let mes of reversedChat) {
        if (mes.extra && mes.extra.synopsis == content) {
            delete mes.extra.synopsis;
            break;
        }
    }

    const newContent = getLatestSynopsisFromChat(context.chat);
    setSynopsisContext(newContent, false);
}

function onSynopsisContentInput() {
    const value = $(this).val();
    setSynopsisContext(value, true);
}

function onSynopsisPromptBuilderInput(e) {
    const value = Number(e.target.value);
    extension_settings.synopsis.prompt_builder = value;
    saveSettingsDebounced();
}

function reinsertSynopsis() {
    const existingValue = String($('#synopsis_contents').val());
    setSynopsisContext(existingValue, false);
}

/**
 * Set the synopsis value to the context and save it to the chat message extra.
 * @param {string} value Value of a synopsis
 * @param {boolean} saveToMessage Should the synopsis be saved to the chat message extra
 * @param {number|null} index Index of the chat message to save the synopsis to. If null, the pre-last message is used.
 */
function setSynopsisContext(value, saveToMessage, index = null) {
    setExtensionPrompt(MODULE_NAME, formatSynopsisValue(value), extension_settings.synopsis.position, extension_settings.synopsis.depth, extension_settings.synopsis.scan, extension_settings.synopsis.role);
    $('#synopsis_contents').val(value);

    const synopsisLog = value
        ? `Synopsis set to: ${value}. Position: ${extension_settings.synopsis.position}. Depth: ${extension_settings.synopsis.depth}. Role: ${extension_settings.synopsis.role}`
        : 'Synopsis has no content';
    console.debug(synopsisLog);

    const context = getContext();
    if (saveToMessage && context.chat.length) {
        const idx = index ?? context.chat.length - 2;
        const mes = context.chat[idx < 0 ? 0 : idx];

        if (!mes.extra) {
            mes.extra = {};
        }

        mes.extra.synopsis = value;
        saveChatDebounced();
    }
}

function doPopout(e) {
    const target = e.target;
    //repurposes the zoomed avatar template to server as a floating div
    if ($('#synopsisExtensionPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const originalHTMLClone = $(target).parent().parent().parent().find('.inline-drawer-content').html();
        const originalElement = $(target).parent().parent().parent().find('.inline-drawer-content');
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="synopsisExtensionPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="synopsisExtensionPopoutClose" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
    </div>`;
        const newElement = $(template);
        newElement.attr('id', 'synopsisExtensionPopout')
            .css('opacity', 0)
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();
        const prevSynopsisBoxContents = $('#synopsis_contents').val().toString(); //copy synopsis box before emptying
        originalElement.empty();
        originalElement.html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newElement.append(controlBarHtml).append(originalHTMLClone);
        $('body').append(newElement);
        newElement.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });
        $('#synopsisExtensionDrawerContents').addClass('scrollableInnerFull');
        setSynopsisContext(prevSynopsisBoxContents, false); //paste prev synopsis box contents into popout box
        setupListeners();
        loadSettings();
        loadMovingUIState();

        dragElement(newElement);

        //setup listener for close button to restore extensions menu
        $('#synopsisExtensionPopoutClose').off('click').on('click', function () {
            $('#synopsisExtensionDrawerContents').removeClass('scrollableInnerFull');
            const synopsisPopoutHTML = $('#synopsisExtensionDrawerContents');
            $('#synopsisExtensionPopout').fadeOut(animation_duration, () => {
                originalElement.empty();
                originalElement.append(synopsisPopoutHTML);
                $('#synopsisExtensionPopout').remove();
            });
            loadSettings();
        });
    } else {
        console.debug('saw existing popout, removing');
        $('#synopsisExtensionPopout').fadeOut(animation_duration, () => { $('#synopsisExtensionPopoutClose').trigger('click'); });
    }
}

function setupListeners() {
    //setup shared listeners for popout and regular ext menu
    $('#synopsis_restore').off('click').on('click', onSynopsisRestoreClick);
    $('#synopsis_contents').off('input').on('input', onSynopsisContentInput);
    $('#synopsis_frozen').off('input').on('input', onSynopsisFrozenInput);
    $('#synopsis_skipWIAN').off('input').on('input', onSynopsisSkipWIANInput);
    $('#synopsis_source').off('change').on('change', onSynopsisSourceChange);
    $('#synopsis_prompt_words').off('input').on('input', onSynopsisPromptWordsInput);
    $('#synopsis_prompt_interval').off('input').on('input', onSynopsisPromptIntervalInput);
    $('#synopsis_prompt').off('input').on('input', onSynopsisPromptInput);
    $('#synopsis_force_summarize').off('click').on('click', () => forceSummarizeChat(false));
    $('#synopsis_template').off('input').on('input', onSynopsisTemplateInput);
    $('#synopsis_depth').off('input').on('input', onSynopsisDepthInput);
    $('#synopsis_role').off('input').on('input', onSynopsisRoleInput);
    $('input[name="synopsis_position"]').off('change').on('change', onSynopsisPositionChange);
    $('#synopsis_prompt_words_force').off('input').on('input', onSynopsisPromptWordsForceInput);
    $('#synopsis_prompt_builder_default').off('input').on('input', onSynopsisPromptBuilderInput);
    $('#synopsis_prompt_builder_raw_blocking').off('input').on('input', onSynopsisPromptBuilderInput);
    $('#synopsis_prompt_builder_raw_non_blocking').off('input').on('input', onSynopsisPromptBuilderInput);
    $('#synopsis_prompt_restore').off('click').on('click', onSynopsisPromptRestoreClick);
    $('#synopsis_prompt_interval_auto').off('click').on('click', onPromptIntervalAutoClick);
    $('#synopsis_prompt_words_auto').off('click').on('click', onPromptForceWordsAutoClick);
    $('#synopsis_override_response_length').off('input').on('input', onOverrideResponseLengthInput);
    $('#synopsis_max_messages_per_request').off('input').on('input', onMaxMessagesPerRequestInput);
    $('#synopsis_include_wi_scan').off('input').on('input', onSynopsisIncludeWIScanInput);
    $('#synopsisSettingsBlockToggle').off('click').on('click', function () {
        $('#synopsisSettingsBlock').slideToggle(200, 'swing');
    });
}

jQuery(async function () {
    async function addExtensionControls() {
        const settingsHtml = await renderExtensionTemplateAsync('synopsis', 'settings', { defaultSettings });
        $('#synopsis_container').append(settingsHtml);
        setupListeners();
        $('#synopsisExtensionPopoutButton').off('click').on('click', function (e) {
            doPopout(e);
            e.stopPropagation();
        });
    }

    await addExtensionControls();
    loadSettings();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    for (const event of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(event, onChatEvent);
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'makesynopsis',
        callback: makesynopsisCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument('source', 'API to use for summarization', [ARGUMENT_TYPE.STRING], false, false, '', Object.values(synopsis_sources)),
            SlashCommandNamedArgument.fromProps({
                name: 'prompt',
                description: 'prompt to use for summarization',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'suppress the toast message when summarizing the chat',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to summarize', [ARGUMENT_TYPE.STRING], false, false, ''),
        ],
        helpString: 'Summarizes the given text. If no text is provided, the current chat will be summarized. Can specify the source and the prompt to use.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    MacrosParser.registerMacro('synopsis', () => getLatestSynopsisFromChat(getContext().chat));
});