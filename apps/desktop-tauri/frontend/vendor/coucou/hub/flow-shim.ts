// Abito-owned closed Flow adapter. Only dictation_action crosses the injected boundary.
export type FlowKey = 'right_ctrl' | 'right_alt' | 'right_shift' | 'left_ctrl_super';
export type Edge = 'bottom' | 'left' | 'right';
export interface FlowPrefs {
  enabled: boolean; key: FlowKey; edge: Edge; mic: string; keepDays: number; cleanup: boolean;
  defaultStyle: string; summaryEngine: string; openAtLaunch: boolean; voice: boolean; voiceOutput: string; voiceGender: string;
}
export interface ModelsStatus { parakeet: { state: string; fraction?: number; error?: string }; downloadMb: number }
export interface FlowStatus {
  prefs: FlowPrefs; models: ModelsStatus; keys: string; hasClaudeKey: boolean; mics: {name: string; default: boolean}[];
  platform: 'windows' | 'linux'; autostarted: boolean;
}
export type Style = 'verbatim' | 'natural' | 'polished';
export interface Replacement { id: string; from: string; to: string }
export interface Snippet { id: string; trigger: string; text: string }
export interface AppStyle { id: string; name: string; style: Style }
export interface FlowEntry { id: string; date: number; text: string; app?: string | null; words: number; seconds: number }
export interface Totals { words: number; seconds: number; dictations: number; wordsPerMinute: number; minutesSaved: number }
export interface FlowStats { week: Totals; month: Totals; all: Totals; daily: [string, number][]; apps: Record<string, number>; streak: number }
export interface Words { words: string[]; replacements: Replacement[] }
let invoke: ((command: string, args: any) => Promise<any>) | undefined;
let hasStatus = false;
export function setInvoke(fn: typeof invoke) { invoke = fn; hasStatus = false; }
const call = (payload: any) => invoke ? invoke('dictation_action', { payload }) : Promise.reject(new Error('No disponible todavía'));
async function mutation(payload: any): Promise<{ok: true}> {
  const reply = await call(payload);
  if (reply?.ok !== true) throw new Error('No se pudo completar');
  return reply;
}
export const FlowBridge = Object.freeze({
  status: async (): Promise<FlowStatus | null> => {
    try { const status = await call({action:'status'}); hasStatus = !!status; return status; }
    catch { hasStatus = false; return null; }
  },
  setPrefs: async (p: FlowPrefs): Promise<Partial<FlowPrefs>> => {
    if (!hasStatus) throw new Error('No disponible todavía'); // Never overwrite unread stored prefs with shell defaults.
    return call({ action:'set_prefs', prefs: {
      enabled:p.enabled, key:p.key, edge:p.edge, mic:p.mic, keepDays:p.keepDays, cleanup:p.cleanup === true, defaultStyle:p.defaultStyle,
    } });
  },
  copyEntry: (id: string) => mutation({action:'copy_entry', id}),
  copyLast: () => mutation({action:'copy_last'}),
  history: (): Promise<FlowEntry[]> => call({action:'history'}),
  deleteEntry: (id: string) => mutation({action:'delete_entry', id}),
  clear: (everything: boolean) => mutation({action:'clear_history', everything}),
  stats: (): Promise<FlowStats> => call({action:'stats'}),
  words: (): Promise<Words> => call({action:'words'}),
  setWords: (words: Words) => mutation({action:'set_words', words}),
  snippets: (): Promise<Snippet[]> => call({action:'snippets'}),
  setSnippets: (snippets: Snippet[]) => mutation({action:'set_snippets', snippets}),
  styles: (): Promise<AppStyle[]> => call({action:'styles'}),
  setStyles: (styles: AppStyle[]) => mutation({action:'set_styles', styles}),
  runningApps: (): Promise<{id: string; name: string}[]> => call({action:'running_apps'}),
  download: (): Promise<ModelsStatus> => call({action:'download_model'}),
  removeModels: (): Promise<ModelsStatus> => call({action:'remove_model'}),
});

// #488: the one closed voice command (OK Koda).
export interface VoicePrefs { enabled: boolean; output: 'system' | 'elevenlabs' | 'off'; gender: 'female' | 'male'; sensitivity: number }
const voiceCall = (payload: any) => invoke ? invoke('voice_action', { payload }) : Promise.reject(new Error('No disponible todavía'));
export const VoiceBridge = Object.freeze({
  status: async (): Promise<any | null> => { try { return await voiceCall({action:'status'}); } catch { return null; } },
  setPrefs: (p: VoicePrefs) => voiceCall({action:'set_prefs', prefs:{enabled:p.enabled === true, output:p.output, gender:p.gender, sensitivity:Math.max(0, Math.min(100, Math.round(Number(p.sensitivity ?? 50))))}}),
  download: () => voiceCall({action:'download_model'}),
  remove: () => voiceCall({action:'remove_model'}),
  // «Entrenar mi voz»: closed, argument-free steps; the host keeps the text, never audio.
  trainRecord: () => voiceCall({action:'train_record'}),
  trainUndo: () => voiceCall({action:'train_undo'}),
  trainCancel: () => voiceCall({action:'train_cancel'}),
  trainFinish: () => voiceCall({action:'train_finish'}),
  trainReset: () => voiceCall({action:'train_reset'}),
  // Ajustes → Voz: language, model in use, custom words; explicit model download / cancel / delete.
  setSpeech: (speech: {language: string; model: string; words: string[]}) => voiceCall({action:'set_speech', speech:{language:String(speech.language), model:String(speech.model), words:speech.words.map(String)}}),
  modelDownload: (id: string) => voiceCall({action:'model_download', id}),
  modelCancel: (id: string) => voiceCall({action:'model_cancel', id}),
  modelDelete: (id: string) => voiceCall({action:'model_delete', id}),
});
