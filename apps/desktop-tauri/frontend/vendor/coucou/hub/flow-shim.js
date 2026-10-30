// Abito-owned closed Flow adapter. Only dictation_action crosses the injected boundary.
let invoke;
let hasStatus = false;
function setInvoke(fn) {
  invoke = fn;
  hasStatus = false;
}
const call = (payload) => invoke ? invoke("dictation_action", { payload }) : Promise.reject(new Error("No disponible todavía"));
async function mutation(payload) {
  const reply = await call(payload);
  if (reply?.ok !== true) throw new Error("No se pudo completar");
  return reply;
}
const FlowBridge = Object.freeze({
  status: async () => {
    try {
      const status = await call({ action: "status" });
      hasStatus = !!status;
      return status;
    } catch {
      hasStatus = false;
      return null;
    }
  },
  setPrefs: async (p) => {
    if (!hasStatus) throw new Error("No disponible todavía");
    return call({ action: "set_prefs", prefs: {
      enabled: p.enabled,
      key: p.key,
      edge: p.edge,
      mic: p.mic,
      keepDays: p.keepDays,
      cleanup: p.cleanup === true,
      defaultStyle: p.defaultStyle
    } });
  },
  copyEntry: (id) => mutation({ action: "copy_entry", id }),
  copyLast: () => mutation({ action: "copy_last" }),
  history: () => call({ action: "history" }),
  deleteEntry: (id) => mutation({ action: "delete_entry", id }),
  clear: (everything) => mutation({ action: "clear_history", everything }),
  stats: () => call({ action: "stats" }),
  words: () => call({ action: "words" }),
  setWords: (words) => mutation({ action: "set_words", words }),
  snippets: () => call({ action: "snippets" }),
  setSnippets: (snippets) => mutation({ action: "set_snippets", snippets }),
  styles: () => call({ action: "styles" }),
  setStyles: (styles) => mutation({ action: "set_styles", styles }),
  runningApps: () => call({ action: "running_apps" }),
  download: () => call({ action: "download_model" }),
  removeModels: () => call({ action: "remove_model" })
});
const voiceCall = (payload) => invoke ? invoke("voice_action", { payload }) : Promise.reject(new Error("No disponible todavía"));
const VoiceBridge = Object.freeze({
  status: async () => {
    try {
      return await voiceCall({ action: "status" });
    } catch {
      return null;
    }
  },
  setPrefs: (p) => voiceCall({ action: "set_prefs", prefs: { enabled: p.enabled === true, output: p.output, gender: p.gender, sensitivity: Math.max(0, Math.min(100, Math.round(Number(p.sensitivity ?? 50)))) } }),
  download: () => voiceCall({ action: "download_model" }),
  remove: () => voiceCall({ action: "remove_model" }),
  // «Entrenar mi voz»: closed, argument-free steps; the host keeps the text, never audio.
  trainRecord: () => voiceCall({ action: "train_record" }),
  trainUndo: () => voiceCall({ action: "train_undo" }),
  trainCancel: () => voiceCall({ action: "train_cancel" }),
  trainFinish: () => voiceCall({ action: "train_finish" }),
  trainReset: () => voiceCall({ action: "train_reset" }),
  // Ajustes → Voz: language, model in use, custom words; explicit model download / cancel / delete.
  setSpeech: (speech) => voiceCall({ action: "set_speech", speech: { language: String(speech.language), model: String(speech.model), words: speech.words.map(String) } }),
  modelDownload: (id) => voiceCall({ action: "model_download", id }),
  modelCancel: (id) => voiceCall({ action: "model_cancel", id }),
  modelDelete: (id) => voiceCall({ action: "model_delete", id })
});
export {
  FlowBridge,
  VoiceBridge,
  setInvoke
};
