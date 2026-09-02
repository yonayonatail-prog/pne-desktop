import { IrodoriTTS } from './pipeline.mjs';

const MODEL_REVISION = 'b75a9bbf2c10e12682d37e91e0efaf6d4e54bd29';
const MODEL_BUNDLE_VERSION = 'pne-bundle-v2-clean-onnx';
const MODEL_BASE = new URL(`/vendor/irodori-tts-webgpu/models/${MODEL_REVISION}/onnx_fp16/`, document.baseURI);
const MODEL_TOTAL_BYTES = 1_255_448_441;
const MODEL_SOURCE = 'bundled';
const MODEL_COMPONENTS = [
    { key: 'text', name: 'text_encoder' },
    { key: 'speaker', name: 'speaker_encoder' },
    { key: 'duration', name: 'duration' },
    { key: 'enc', name: 'dacvae_encoder' },
    { key: 'dac', name: 'dacvae_decoder' },
    { key: 'dit', name: 'dit' }
];

const VENDORED_RUNTIME_BASE = new URL('/vendor/irodori-tts-webgpu/runtime/', document.baseURI);
const ORT_MODULE_URL = new URL('ort.webgpu-1.23.0.mjs', VENDORED_RUNTIME_BASE).href;
const ORT_WASM_MODULE_URL = new URL('ort-wasm-simd-threaded.asyncify.mjs', VENDORED_RUNTIME_BASE).href;
const ORT_WASM_URL = new URL('ort-wasm-simd-threaded.asyncify.wasm', VENDORED_RUNTIME_BASE).href;
const TRANSFORMERS_MODULE_URL = new URL('transformers-3.7.6.mjs', VENDORED_RUNTIME_BASE).href;
const TOKENIZER_PATH = new URL('/vendor/irodori-tts-webgpu/tokenizer/', document.baseURI).href;

const GENERATED_DB_NAME = 'pne-name-voice-v1';
const GENERATED_STORE_NAME = 'voices';
const GENERATED_CACHE_VERSION = 'PNE_NAMEVOICE_V1';
const MODEL_VERSION = `irodori-tts-500m-v3-fp16-${MODEL_REVISION.slice(0, 12)}`;
const TEMPLATE_VERSION = 'context-v1-direct-v1';

export const HONORIFIC_READINGS = Object.freeze({
    bare: '',
    chan: 'ちゃん',
    san: 'さん',
    kun: 'くん',
    senpai: '先輩'
});

const CONTEXT_TEMPLATES = Object.freeze([
    (call) => `ねぇ。${call}。こっち。`,
    (call) => `そうだ。${call}。聞いて。`,
    (call) => `ほら。${call}。こっち。`
]);

const VAD_CONFIG = Object.freeze({
    windowMs: 10,
    minSpeechMs: 80,
    minSilenceMs: 80,
    thresholdDb: -40,
    paddingBeforeMs: 40,
    paddingAfterMs: 60
});

function createNameVoiceError(code, message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.name = 'NameVoiceError';
    error.code = code;
    return error;
}

function abortError() {
    return new DOMException('The name voice request was replaced.', 'AbortError');
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || abortError();
}

function normalizeReading(value) {
    return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function normalizeForm(form) {
    const value = String(form || 'bare').trim();
    return Object.prototype.hasOwnProperty.call(HONORIFIC_READINGS, value) ? value : 'bare';
}

export function buildNameCall(reading, form = 'bare') {
    const normalizedReading = normalizeReading(reading);
    return normalizedReading + HONORIFIC_READINGS[normalizeForm(form)];
}

export function collectNameVoiceRequests(pack) {
    const requests = new Map();
    if (!pack || !Array.isArray(pack.nodes)) return [];

    for (const node of pack.nodes) {
        if (!node || !node.text || !node.voice_id) continue;
        const regex = /\{\{name(?::([^}]+))?\}\}/g;
        let match;
        while ((match = regex.exec(String(node.text))) !== null) {
            const form = normalizeForm(match[1] || 'bare');
            const key = `${node.voice_id}|${form}`;
            if (!requests.has(key)) {
                requests.set(key, {
                    voiceId: String(node.voice_id),
                    form,
                    firstNodeId: node.id || null
                });
            }
        }
    }

    const preview = pack.start_screen?.name_voice;
    if (preview?.voice_id) {
        const form = normalizeForm(preview.preview_form || 'bare');
        const key = `${preview.voice_id}|${form}`;
        if (!requests.has(key)) {
            requests.set(key, {
                voiceId: String(preview.voice_id),
                form,
                firstNodeId: null
            });
        }
        const ordered = [...requests.values()];
        const previewIndex = ordered.findIndex((request) => request.voiceId === String(preview.voice_id) && request.form === form);
        if (previewIndex > 0) ordered.unshift(ordered.splice(previewIndex, 1)[0]);
        return ordered;
    }

    return [...requests.values()];
}

function cachePart(value) {
    return encodeURIComponent(String(value ?? ''));
}

export function buildGeneratedCacheKey(request) {
    return [
        GENERATED_CACHE_VERSION,
        request.modelVersion || MODEL_VERSION,
        request.voiceId,
        request.referenceFingerprint || request.referenceVersion || 'reference-v1',
        request.reading,
        request.form,
        TEMPLATE_VERSION
    ].map(cachePart).join('|');
}

function requestResultKey(voiceId, form) {
    return `${voiceId}|${normalizeForm(form)}`;
}

function requestDebugInfo(request) {
    return {
        voiceId: request?.voiceId || '',
        form: normalizeForm(request?.form),
        firstNodeId: request?.firstNodeId || null
    };
}

function modelInitializationDebugInfo(error) {
    const detail = {
        code: error?.code || 'MODEL_INITIALIZATION_FAILED',
        errorType: error?.name || 'Error',
        stage: error?.stage || 'session-create',
        component: error?.component || null
    };
    const cause = error?.cause;
    if (!cause) return detail;
    detail.causeType = cause.name || 'Error';
    if (['string', 'number'].includes(typeof cause.code)) detail.causeCode = cause.code;
    detail.causeMessage = String(cause.message || cause)
        .replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
            try {
                const url = new URL(value);
                url.search = '';
                url.hash = '';
                return url.href;
            } catch {
                return '[URL]';
            }
        })
        .slice(0, 500);
    return detail;
}

function openGeneratedDatabase() {
    if (!('indexedDB' in globalThis)) {
        return Promise.reject(createNameVoiceError('CACHE_UNAVAILABLE', 'IndexedDB is unavailable.'));
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(GENERATED_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(GENERATED_STORE_NAME)) {
                database.createObjectStore(GENERATED_STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || createNameVoiceError('CACHE_OPEN_FAILED', 'Could not open the name voice cache.'));
    });
}

function databaseRequest(mode, operation) {
    return openGeneratedDatabase().then((database) => new Promise((resolve, reject) => {
        const transaction = database.transaction(GENERATED_STORE_NAME, mode);
        const store = transaction.objectStore(GENERATED_STORE_NAME);
        let request;
        try {
            request = operation(store);
        } catch (error) {
            database.close();
            reject(error);
            return;
        }
        transaction.oncomplete = () => {
            database.close();
            resolve(request?.result);
        };
        transaction.onerror = () => {
            const error = transaction.error || request?.error || createNameVoiceError('CACHE_TRANSACTION_FAILED', 'The name voice cache operation failed.');
            database.close();
            reject(error);
        };
        transaction.onabort = transaction.onerror;
    }));
}

export class NameVoiceStore {
    async get(key) {
        return databaseRequest('readonly', (store) => store.get(key));
    }

    async put(record) {
        return databaseRequest('readwrite', (store) => store.put(record));
    }

    async clear() {
        return databaseRequest('readwrite', (store) => store.clear());
    }
}

function fnv1a(bytes) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < bytes.length; index += 1) {
        hash ^= bytes[index];
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

async function decodeToMono48k(arrayBuffer) {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    const OfflineContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!AudioContextClass || !OfflineContextClass) {
        throw createNameVoiceError('AUDIO_CONTEXT_UNAVAILABLE', 'Web Audio is unavailable.');
    }

    const context = new AudioContextClass();
    let decoded;
    try {
        decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    } catch (error) {
        throw createNameVoiceError('REFERENCE_DECODE_FAILED', 'The character reference audio could not be decoded.', error);
    } finally {
        await context.close().catch(() => {});
    }

    const frameCount = Math.max(1, Math.ceil(decoded.duration * 48_000));
    const offline = new OfflineContextClass(1, frameCount, 48_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
}

function encodeWav(samples, sampleRate) {
    const sampleCount = samples.length;
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) {
            view.setUint8(offset + index, text.charCodeAt(index));
        }
    };

    writeText(0, 'RIFF');
    view.setUint32(4, 36 + sampleCount * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, sampleCount * 2, true);

    for (let index = 0; index < sampleCount; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        view.setInt16(44 + index * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

function dbToAmplitude(db) {
    return 10 ** (db / 20);
}

export function detectSpeechSegments(samples, sampleRate, config = VAD_CONFIG) {
    const windowFrames = Math.max(1, Math.round(sampleRate * config.windowMs / 1000));
    const minimumSpeechWindows = Math.max(1, Math.ceil(config.minSpeechMs / config.windowMs));
    const minimumSilenceWindows = Math.max(1, Math.ceil(config.minSilenceMs / config.windowMs));
    const absoluteThreshold = dbToAmplitude(config.thresholdDb);
    const rmsValues = [];
    let peakRms = 0;

    for (let start = 0; start < samples.length; start += windowFrames) {
        const end = Math.min(samples.length, start + windowFrames);
        let sumSquares = 0;
        for (let index = start; index < end; index += 1) {
            sumSquares += samples[index] * samples[index];
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
        rmsValues.push(rms);
        peakRms = Math.max(peakRms, rms);
    }

    const adaptiveThreshold = Math.max(absoluteThreshold, peakRms * 0.035);
    const rawSegments = [];
    let speechStart = null;
    let silenceWindows = 0;

    for (let index = 0; index < rmsValues.length; index += 1) {
        const speech = rmsValues[index] >= adaptiveThreshold;
        if (speech) {
            if (speechStart == null) speechStart = index;
            silenceWindows = 0;
            continue;
        }

        if (speechStart != null) {
            silenceWindows += 1;
            if (silenceWindows >= minimumSilenceWindows) {
                const speechEnd = index - silenceWindows + 1;
                if (speechEnd - speechStart >= minimumSpeechWindows) {
                    rawSegments.push({ startWindow: speechStart, endWindow: speechEnd });
                }
                speechStart = null;
                silenceWindows = 0;
            }
        }
    }

    if (speechStart != null) {
        const speechEnd = rmsValues.length;
        if (speechEnd - speechStart >= minimumSpeechWindows) {
            rawSegments.push({ startWindow: speechStart, endWindow: speechEnd });
        }
    }

    return rawSegments.map((segment) => ({
        startMs: segment.startWindow * config.windowMs,
        endMs: Math.min(samples.length / sampleRate * 1000, segment.endWindow * config.windowMs),
        threshold: adaptiveThreshold
    }));
}

export function selectContextNameSegment(segments) {
    if (!Array.isArray(segments) || segments.length !== 3) return null;
    const target = segments[1];
    const durationMs = target.endMs - target.startMs;
    return durationMs >= 100 && durationMs <= 3000 ? target : null;
}

function sliceSamples(samples, sampleRate, segment, config = VAD_CONFIG) {
    const startMs = Math.max(0, segment.startMs - config.paddingBeforeMs);
    const endMs = Math.min(samples.length / sampleRate * 1000, segment.endMs + config.paddingAfterMs);
    const startFrame = Math.floor(startMs * sampleRate / 1000);
    const endFrame = Math.ceil(endMs * sampleRate / 1000);
    return samples.slice(startFrame, Math.max(startFrame + 1, endFrame));
}

function trimDirectCall(samples, sampleRate, segments) {
    if (!segments.length) return samples;
    const segment = {
        startMs: segments[0].startMs,
        endMs: segments[segments.length - 1].endMs
    };
    return sliceSamples(samples, sampleRate, segment);
}

async function readResponseBytes(response, fallbackSize, onBytes) {
    if (!response.ok) {
        throw createNameVoiceError('MODEL_DOWNLOAD_FAILED', `Model download failed: HTTP ${response.status}`);
    }
    const headerSize = Number(response.headers.get('content-length'));
    const expectedSize = Number.isFinite(headerSize) && headerSize > 0 ? headerSize : fallbackSize;
    if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        onBytes?.(bytes.byteLength);
        return bytes;
    }

    const reader = response.body.getReader();
    let output = new Uint8Array(Math.max(1, expectedSize || 1));
    let offset = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > output.byteLength) {
            const expanded = new Uint8Array(Math.max(offset + value.byteLength, output.byteLength * 2));
            expanded.set(output);
            output = expanded;
        }
        output.set(value, offset);
        offset += value.byteLength;
        onBytes?.(value.byteLength);
    }
    return offset === output.byteLength ? output : output.slice(0, offset);
}

async function getModelResponse(url) {
    // The release bundle contains all graph and external-data files. Keep the
    // model local so first launch works without a network connection and so a
    // second 1.25 GB copy is not created in Cache Storage.
    try {
        return {
            response: await fetch(url, { cache: 'force-cache' }),
            cached: false,
            bundled: true,
            cachePromise: Promise.resolve()
        };
    } catch (error) {
        throw createNameVoiceError('MODEL_DOWNLOAD_FAILED', 'The bundled Irodori model could not be read.', error);
    }
}

export class IrodoriAdapter {
    constructor() {
        this.modelPromise = null;
        this.tts = null;
        this.referencePromises = new Map();
        this.generationTail = Promise.resolve();
        this.modelProgressListeners = new Set();
        this.modelProgressSnapshot = null;
    }

    async initialize(onProgress) {
        if (onProgress) {
            this.modelProgressListeners.add(onProgress);
            if (this.modelProgressSnapshot) onProgress(this.modelProgressSnapshot);
        }
        try {
            if (this.tts) return this.tts;
            if (!this.modelPromise) {
                this.modelPromise = this.#loadModels((event) => {
                    this.modelProgressSnapshot = event;
                    for (const listener of this.modelProgressListeners) {
                        try { listener(event); } catch (error) { console.warn('[NameVoice] progress listener failed', error); }
                    }
                }).catch((error) => {
                    this.modelPromise = null;
                    throw error;
                });
            }
            return await this.modelPromise;
        } finally {
            if (onProgress) this.modelProgressListeners.delete(onProgress);
        }
    }

    async #loadModels(onProgress) {
        if (!globalThis.isSecureContext || !navigator.gpu) {
            throw createNameVoiceError('WEBGPU_UNAVAILABLE', 'WebGPU requires current Chrome on HTTPS or localhost.');
        }
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw createNameVoiceError('WEBGPU_UNAVAILABLE', 'No WebGPU adapter was found.');

        onProgress?.({ state: 'loading-model', progress: 0, loadedBytes: 0, totalBytes: MODEL_TOTAL_BYTES, source: MODEL_SOURCE });
        let ort;
        let AutoTokenizer;
        let env;
        try {
            const [ortModule, transformersModule] = await Promise.all([
                import(ORT_MODULE_URL),
                import(TRANSFORMERS_MODULE_URL)
            ]);
            ort = ortModule;
            ({ AutoTokenizer, env } = transformersModule);
        } catch (error) {
            throw createNameVoiceError('RUNTIME_LOAD_FAILED', 'The local voice runtime could not be loaded.', error);
        }

        ort.env.wasm.wasmPaths = {
            mjs: ORT_WASM_MODULE_URL,
            wasm: ORT_WASM_URL
        };
        ort.env.logLevel = 'error';
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = TOKENIZER_PATH;

        const sessions = {};
        let loadedBytes = 0;
        let lastByteProgressAt = 0;
        for (let index = 0; index < MODEL_COMPONENTS.length; index += 1) {
            const component = MODEL_COMPONENTS[index];
            const graphUrl = new URL(`${component.name}.onnx?bundle=${MODEL_BUNDLE_VERSION}`, MODEL_BASE).href;
            const dataUrl = new URL(`${component.name}.onnx.data?bundle=${MODEL_BUNDLE_VERSION}`, MODEL_BASE).href;
            onProgress?.({
                state: 'loading-model',
                progress: Math.min(0.9, loadedBytes / MODEL_TOTAL_BYTES * 0.9),
                loadedBytes,
                totalBytes: MODEL_TOTAL_BYTES,
                component: component.name,
                componentIndex: index,
                componentTotal: MODEL_COMPONENTS.length,
                source: MODEL_SOURCE
            });

            let graph;
            let data;
            try {
                const [graphResult, dataResult] = await Promise.all([
                    getModelResponse(graphUrl),
                    getModelResponse(dataUrl)
                ]);
                const onBytes = (count) => {
                    loadedBytes += count;
                    const now = Date.now();
                    if (now - lastByteProgressAt < 160) return;
                    lastByteProgressAt = now;
                    onProgress?.({
                        state: 'loading-model',
                        progress: Math.min(0.9, loadedBytes / MODEL_TOTAL_BYTES * 0.9),
                        loadedBytes,
                        totalBytes: MODEL_TOTAL_BYTES,
                        component: component.name,
                        componentIndex: index,
                        componentTotal: MODEL_COMPONENTS.length,
                        cached: graphResult.cached && dataResult.cached,
                        source: MODEL_SOURCE
                    });
                };
                [graph, data] = await Promise.all([
                    readResponseBytes(graphResult.response, 0, onBytes),
                    readResponseBytes(dataResult.response, 0, onBytes)
                ]);
                await Promise.all([graphResult.cachePromise, dataResult.cachePromise]);
                onProgress?.({
                    state: 'loading-model',
                    progress: Math.min(0.9, loadedBytes / MODEL_TOTAL_BYTES * 0.9),
                    loadedBytes,
                    totalBytes: MODEL_TOTAL_BYTES,
                    component: component.name,
                    componentIndex: index,
                    componentTotal: MODEL_COMPONENTS.length,
                    cached: graphResult.cached && dataResult.cached,
                    source: MODEL_SOURCE
                });
            } catch (error) {
                if (error?.code) throw error;
                throw createNameVoiceError('MODEL_DOWNLOAD_FAILED', `Could not load ${component.name}.`, error);
            }

            try {
                sessions[component.key] = await ort.InferenceSession.create(graph, {
                    executionProviders: ['webgpu'],
                    graphOptimizationLevel: 'all',
                    logSeverityLevel: 3,
                    externalData: [{ path: `${component.name}.onnx.data`, data }]
                });
            } catch (error) {
                const wrapped = createNameVoiceError('MODEL_INITIALIZATION_FAILED', `Could not initialize ${component.name}.`, error);
                wrapped.stage = 'session-create';
                wrapped.component = component.name;
                throw wrapped;
            }
        }

        onProgress?.({ state: 'loading-model', progress: 0.94, loadedBytes: MODEL_TOTAL_BYTES, totalBytes: MODEL_TOTAL_BYTES, source: MODEL_SOURCE });
        let tokenizer;
        try {
            tokenizer = await AutoTokenizer.from_pretrained('llmjp_tok');
        } catch (error) {
            throw createNameVoiceError('TOKENIZER_LOAD_FAILED', 'The Japanese tokenizer could not be loaded.', error);
        }

        this.tts = new IrodoriTTS({ ort, sessions, tokenizer });
        onProgress?.({ state: 'loading-model', progress: 1, loadedBytes: MODEL_TOTAL_BYTES, totalBytes: MODEL_TOTAL_BYTES, source: MODEL_SOURCE });
        return this.tts;
    }

    async loadReference(referenceUrl) {
        const absoluteUrl = new URL(referenceUrl, document.baseURI).href;
        if (!this.referencePromises.has(absoluteUrl)) {
            this.referencePromises.set(absoluteUrl, (async () => {
                let response;
                try {
                    response = await fetch(absoluteUrl, { cache: 'no-store' });
                } catch (error) {
                    throw createNameVoiceError('REFERENCE_LOAD_FAILED', 'The character reference audio could not be loaded.', error);
                }
                if (!response.ok) {
                    throw createNameVoiceError('REFERENCE_LOAD_FAILED', `The character reference audio returned HTTP ${response.status}.`);
                }
                const arrayBuffer = await response.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                return {
                    samples: await decodeToMono48k(arrayBuffer),
                    fingerprint: fnv1a(bytes),
                    url: absoluteUrl
                };
            })().catch((error) => {
                this.referencePromises.delete(absoluteUrl);
                throw error;
            }));
        }
        return this.referencePromises.get(absoluteUrl);
    }

    invalidateReferences() {
        this.referencePromises.clear();
    }

    // Shared dialogue entry point. The authoring voice pipeline owns context
    // construction and trimming; this method only performs one raw Irodori
    // inference with an explicit reference and duration policy.
    async synthesizeContext(text, referenceUrl, options = {}) {
        const { signal, onProgress, numSteps = 34, seed = 0, seconds } = options;
        const modelPromise = this.initialize(onProgress);
        const referencePromise = this.loadReference(referenceUrl);
        modelPromise.catch(() => {});
        referencePromise.catch(() => {});
        const task = async () => {
            throwIfAborted(signal);
            const [tts, reference] = await Promise.all([modelPromise, referencePromise]);
            throwIfAborted(signal);
            const generated = await tts.synthesize(text, reference.samples, 48_000, {
                numSteps,
                seed,
                seconds,
                onProgress: (progress) => onProgress?.({ state: 'generating', progress })
            });
            throwIfAborted(signal);
            return { ...generated, referenceFingerprint: reference.fingerprint };
        };
        const result = this.generationTail.catch(() => {}).then(task);
        this.generationTail = result;
        return result;
    }

    async generate(request, { signal, onProgress } = {}) {
        const modelPromise = this.initialize(onProgress);
        const referencePromise = this.loadReference(request.referenceUrl);
        modelPromise.catch(() => {});
        referencePromise.catch(() => {});
        const task = async () => {
            throwIfAborted(signal);
            const [tts, reference] = await Promise.all([
                modelPromise,
                referencePromise
            ]);
            throwIfAborted(signal);

            const callReading = buildNameCall(request.reading, request.form);
            const diagnostics = [];
            for (let index = 0; index < CONTEXT_TEMPLATES.length; index += 1) {
                throwIfAborted(signal);
                onProgress?.({
                    state: 'generating',
                    progress: 0.15 + index * 0.17,
                    attempt: index + 1,
                    attemptTotal: CONTEXT_TEMPLATES.length,
                    callReading
                });
                const text = CONTEXT_TEMPLATES[index](callReading);
                const generated = await tts.synthesize(text, reference.samples, 48_000, {
                    numSteps: 16,
                    seed: 0
                });
                throwIfAborted(signal);

                onProgress?.({ state: 'cutting', progress: 0.66, callReading });
                const segments = detectSpeechSegments(generated.audio, generated.sampleRate);
                const target = selectContextNameSegment(segments);
                diagnostics.push({ template: index, segments });
                console.info('[NameVoice] vad', { request: requestDebugInfo(request), template: index, segments });
                if (target) {
                    const samples = sliceSamples(generated.audio, generated.sampleRate, target);
                    return {
                        blob: encodeWav(samples, generated.sampleRate),
                        samples,
                        sampleRate: generated.sampleRate,
                        callReading,
                        cutMode: 'context-middle',
                        diagnostics,
                        referenceFingerprint: reference.fingerprint
                    };
                }
            }

            throwIfAborted(signal);
            onProgress?.({ state: 'generating', progress: 0.72, attempt: 1, attemptTotal: 1, callReading, fallback: true });
            const direct = await tts.synthesize(`${callReading}。`, reference.samples, 48_000, {
                numSteps: 16,
                seed: 0
            });
            throwIfAborted(signal);
            const directSegments = detectSpeechSegments(direct.audio, direct.sampleRate);
            const samples = trimDirectCall(direct.audio, direct.sampleRate, directSegments);
            diagnostics.push({ template: 'direct', segments: directSegments });
            return {
                blob: encodeWav(samples, direct.sampleRate),
                samples,
                sampleRate: direct.sampleRate,
                callReading,
                cutMode: 'direct-fallback',
                diagnostics,
                referenceFingerprint: reference.fingerprint
            };
        };

        const result = this.generationTail.catch(() => {}).then(task);
        this.generationTail = result;
        return result;
    }
}

function profileSignature(profile) {
    return [
        String(profile?.name || '').normalize('NFC').trim(),
        normalizeReading(profile?.reading)
    ];
}

export class NameVoiceManager {
    constructor({ adapter = new IrodoriAdapter(), store = new NameVoiceStore(), onState = () => {} } = {}) {
        this.adapter = adapter;
        this.store = store;
        this.onState = onState;
        this.runId = 0;
        this.controller = null;
        this.activeSignature = '';
        this.activePromise = null;
        this.readySignature = '';
        this.results = new Map();
        this.lastResult = null;
    }

    emit(detail) {
        this.onState({ ...detail, runId: this.runId });
    }

    cancel() {
        this.runId += 1;
        this.controller?.abort(abortError());
        this.controller = null;
        this.activeSignature = '';
        this.activePromise = null;
        // A cancelled run must never leave a previous person's voice available
        // to story playback while the replacement is pending or has failed.
        this.results.clear();
        this.readySignature = '';
        this.lastResult = null;
    }

    async prepare({ pack, profile }) {
        const requests = collectNameVoiceRequests(pack);
        const requestSignature = requests.map((request) => {
            const voiceProfile = pack?.voice_profiles?.[request.voiceId] || {};
            return [
                requestResultKey(request.voiceId, request.form),
                voiceProfile.reference || '',
                voiceProfile.reference_version || ''
            ];
        });
        const signature = JSON.stringify([profileSignature(profile), requestSignature]);
        if (signature === this.readySignature && this.lastResult) {
            this.emit({
                state: this.lastResult.partial ? 'partial' : 'ready',
                progress: 1,
                total: this.lastResult.results.size,
                completed: this.lastResult.results.size,
                preview: this.lastResult.preview,
                errors: this.lastResult.errors
            });
            return this.lastResult;
        }
        if (signature === this.activeSignature && this.activePromise) return this.activePromise;

        this.cancel();
        const runId = this.runId;
        const controller = new AbortController();
        this.controller = controller;
        this.activeSignature = signature;
        this.emit({ state: 'scanning', progress: 0, total: requests.length, completed: 0 });

        this.activePromise = this.#prepareRun({ pack, profile, requests, signature, runId, signal: controller.signal })
            .finally(() => {
                if (this.runId === runId) {
                    this.activePromise = null;
                    this.activeSignature = '';
                    this.controller = null;
                }
            });
        return this.activePromise;
    }

    async #prepareRun({ pack, profile, requests, signature, runId, signal }) {
        if (!requests.length) {
            throw createNameVoiceError('NO_NAME_VOICE_REQUESTS', 'This script pack has no name voice requests.');
        }

        const prepared = new Map();
        const errors = [];
        const reading = normalizeReading(profile.reading);
        for (let index = 0; index < requests.length; index += 1) {
            throwIfAborted(signal);
            const request = requests[index];
            const voiceProfile = pack.voice_profiles?.[request.voiceId];
            if (!voiceProfile?.reference) {
                errors.push({ request, code: 'VOICE_PROFILE_MISSING' });
                continue;
            }

            const reference = await this.adapter.loadReference(voiceProfile.reference);
            throwIfAborted(signal);
            const fullRequest = {
                ...request,
                name: String(profile.name || '').trim(),
                reading,
                callReading: buildNameCall(reading, request.form),
                referenceUrl: voiceProfile.reference,
                referenceFingerprint: reference.fingerprint,
                referenceVersion: voiceProfile.reference_version || 'reference-v1',
                modelVersion: MODEL_VERSION
            };
            const cacheKey = buildGeneratedCacheKey(fullRequest);
            this.emit({ state: 'cache-check', progress: index / requests.length, total: requests.length, completed: index, current: fullRequest });

            let cached = null;
            try {
                cached = await this.store.get(cacheKey);
            } catch (error) {
                console.warn('[NameVoice] cache read failed', error);
            }
            throwIfAborted(signal);

            if (cached?.audio instanceof Blob) {
                console.info('[NameVoice] cache-hit', requestDebugInfo(fullRequest));
                prepared.set(requestResultKey(request.voiceId, request.form), {
                    ...fullRequest,
                    blob: cached.audio,
                    cacheKey,
                    cacheHit: true
                });
                this.emit({ state: 'cache-check', progress: (index + 1) / requests.length, total: requests.length, completed: index + 1, current: fullRequest, cacheHit: true });
                continue;
            }

            try {
                console.info('[NameVoice] generate', requestDebugInfo(fullRequest));
                const generated = await this.adapter.generate(fullRequest, {
                    signal,
                    onProgress: (event) => {
                        if (this.runId !== runId || signal.aborted) return;
                        const unitProgress = Math.max(0, Math.min(1, Number(event.progress) || 0));
                        this.emit({
                            ...event,
                            total: requests.length,
                            completed: index,
                            current: fullRequest,
                            overallProgress: (index + unitProgress) / requests.length
                        });
                    }
                });
                throwIfAborted(signal);
                const record = {
                    key: cacheKey,
                    audio: generated.blob,
                    voiceId: request.voiceId,
                    form: request.form,
                    reading,
                    modelVersion: MODEL_VERSION,
                    referenceFingerprint: reference.fingerprint,
                    createdAt: new Date().toISOString()
                };
                let cacheWriteFailed = false;
                this.emit({ state: 'saving', progress: 0.92, total: requests.length, completed: index, current: fullRequest });
                try {
                    await this.store.put(record);
                    console.info('[NameVoice] stored', requestDebugInfo(fullRequest));
                } catch (error) {
                    cacheWriteFailed = true;
                    console.warn('[NameVoice] cache write failed', error);
                }
                prepared.set(requestResultKey(request.voiceId, request.form), {
                    ...fullRequest,
                    ...generated,
                    cacheKey,
                    cacheHit: false,
                    cacheWriteFailed
                });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                console.error(
                    '[NameVoice] failed',
                    requestDebugInfo(fullRequest),
                    error?.code === 'MODEL_INITIALIZATION_FAILED'
                        ? modelInitializationDebugInfo(error)
                        : {
                            code: error?.code || 'TTS_GENERATION_FAILED',
                            errorType: error?.name || 'Error'
                        }
                );
                const code = error?.code || 'TTS_GENERATION_FAILED';
                errors.push({ request: fullRequest, code, error });
                if ([
                    'WEBGPU_UNAVAILABLE',
                    'RUNTIME_LOAD_FAILED',
                    'MODEL_DOWNLOAD_FAILED',
                    'MODEL_INITIALIZATION_FAILED',
                    'TOKENIZER_LOAD_FAILED'
                ].includes(code)) break;
            }
        }

        throwIfAborted(signal);
        if (!prepared.size) {
            const error = errors[0]?.error || createNameVoiceError(errors[0]?.code || 'TTS_GENERATION_FAILED', 'No name voice could be prepared.');
            this.emit({ state: 'error', progress: 1, errors });
            throw error;
        }

        this.results = prepared;
        this.readySignature = signature;
        const previewConfig = pack.start_screen?.name_voice || {};
        // A preview must never silently switch to another character or form.
        // The caller may still start with a partial result; the missing slot
        // is resolved to its declared fallback during playback.
        const preview = prepared.get(requestResultKey(previewConfig.voice_id || requests[0].voiceId, previewConfig.preview_form || requests[0].form))
            || null;
        const result = {
            ready: true,
            partial: errors.length > 0,
            preview,
            results: prepared,
            errors,
            signature
        };
        this.lastResult = result;
        this.emit({ state: errors.length ? 'partial' : 'ready', progress: 1, total: requests.length, completed: prepared.size, preview, errors });
        return result;
    }

    get({ voiceId, form = 'bare' }) {
        if (!this.readySignature || this.lastResult?.signature !== this.readySignature) return null;
        return this.results.get(requestResultKey(voiceId, form)) || null;
    }

    invalidatePack() {
        this.cancel();
        this.results.clear();
        this.readySignature = '';
        this.lastResult = null;
        this.adapter.invalidateReferences?.();
    }

    async clearGeneratedVoices() {
        this.invalidatePack();
        await this.store.clear();
    }
}

export class LocalAudioPlayer {
    constructor() {
        this.context = null;
        this.sources = new Set();
        this.sourceFinishers = new Map();
        this.decodedUrls = new Map();
        this.playRequestId = 0;
    }

    getContext() {
        if (!this.context) {
            const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (!AudioContextClass) throw createNameVoiceError('AUDIO_CONTEXT_UNAVAILABLE', 'Web Audio is unavailable.');
            this.context = new AudioContextClass();
        }
        return this.context;
    }

    async unlock() {
        const context = this.getContext();
        if (context.state !== 'running') await context.resume();
        return context.state === 'running';
    }

    stop() {
        this.playRequestId += 1;
        this.stopSources();
    }

    stopSources() {
        for (const source of [...this.sources]) {
            try { source.stop(); } catch {}
            this.sourceFinishers.get(source)?.();
        }
        this.sources.clear();
    }

    async decodeBlob(blob) {
        const context = this.getContext();
        return context.decodeAudioData((await blob.arrayBuffer()).slice(0));
    }

    async decodeUrl(url) {
        const absoluteUrl = new URL(url, document.baseURI).href;
        if (!this.decodedUrls.has(absoluteUrl)) {
            this.decodedUrls.set(absoluteUrl, (async () => {
                const response = await fetch(absoluteUrl);
                if (!response.ok) throw createNameVoiceError('AUDIO_LOAD_FAILED', `Audio returned HTTP ${response.status}.`);
                return this.getContext().decodeAudioData((await response.arrayBuffer()).slice(0));
            })().catch((error) => {
                this.decodedUrls.delete(absoluteUrl);
                throw error;
            }));
        }
        return this.decodedUrls.get(absoluteUrl);
    }

    async playBlob(blob) {
        const requestId = ++this.playRequestId;
        this.stopSources();
        const buffer = await this.decodeBlob(blob);
        if (requestId !== this.playRequestId) return false;
        return this.playBuffers([buffer], requestId);
    }

    async playSequence(items) {
        const requestId = ++this.playRequestId;
        this.stopSources();
        const buffers = [];
        for (const item of items) {
            if (item instanceof Blob) buffers.push(await this.decodeBlob(item));
            else if (typeof item === 'string') buffers.push(await this.decodeUrl(item));
            if (requestId !== this.playRequestId) return false;
        }
        return this.playBuffers(buffers, requestId);
    }

    async playBuffers(buffers, requestId = this.playRequestId) {
        if (!buffers.length) return false;
        if (requestId !== this.playRequestId) return false;
        const context = this.getContext();
        if (context.state !== 'running') {
            throw createNameVoiceError('AUTOPLAY_BLOCKED', 'Audio playback needs a user gesture.');
        }
        let startAt = context.currentTime + 0.035;
        const completions = [];
        for (const buffer of buffers) {
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            completions.push(new Promise((resolve) => {
                let finished = false;
                const finish = () => {
                    if (finished) return;
                    finished = true;
                    this.sources.delete(source);
                    this.sourceFinishers.delete(source);
                    resolve();
                };
                this.sourceFinishers.set(source, finish);
                source.addEventListener('ended', finish, { once: true });
            }));
            this.sources.add(source);
            try {
                source.start(startAt);
            } catch (error) {
                this.sourceFinishers.get(source)?.();
                this.stopSources();
                throw error;
            }
            startAt += buffer.duration;
        }
        await Promise.all(completions);
        return requestId === this.playRequestId;
    }
}

export const NAME_VOICE_MODEL_INFO = Object.freeze({
    revision: MODEL_REVISION,
    totalBytes: MODEL_TOTAL_BYTES,
    source: MODEL_SOURCE,
    approximateDownloadLabel: 'アプリに同梱（約1.3GB）'
});
