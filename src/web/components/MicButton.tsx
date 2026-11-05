import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice input for a text box (owner request 2026-10-18): the browser Web Speech API turns speech into
 * text. Chrome and Edge have it (they send the audio to Google or Microsoft); other browsers and the
 * Claude desktop browser pane do not, so the button is disabled there with a hint. No dependency and
 * no server change. Final text goes to `onText`; the text that is not final yet shows under the box.
 */

// The Web Speech API is not in the TypeScript DOM lib: the parts used here.
interface SpeechAlternative { transcript: string }
interface SpeechResult { readonly isFinal: boolean; readonly length: number; [index: number]: SpeechAlternative }
interface SpeechResultList { readonly length: number; [index: number]: SpeechResult }
interface SpeechResultEvent { readonly resultIndex: number; readonly results: SpeechResultList }
interface SpeechErrorEvent { readonly error: string }
interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognizerCtor = new () => SpeechRecognizer;

function recognizerCtor(): SpeechRecognizerCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognizerCtor; webkitSpeechRecognition?: SpeechRecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const VOICE_LANGS = [
  { code: 'en-US', label: 'English' },
  { code: 'ar-EG', label: 'العربية (Arabic)' },
] as const;
const LANG_KEY = 'voice-input-lang';

function storedLang(): string {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v && VOICE_LANGS.some((l) => l.code === v)) return v;
  } catch { /* no storage */ }
  return VOICE_LANGS[0].code;
}

function errorText(code: string): string | null {
  switch (code) {
    case 'aborted': return null;
    case 'not-allowed':
    case 'service-not-allowed': return 'The browser cannot use the microphone. Allow the microphone for this page, or press Win + H in Windows.';
    case 'no-speech': return 'No speech was heard. Push the microphone button and speak again.';
    case 'audio-capture': return 'No microphone was found. Connect a microphone and try again.';
    case 'network': return 'Voice input needs an internet connection. Check the connection and try again.';
    case 'language-not-supported': return 'The browser cannot hear this language. Choose the other language.';
    default: return `Voice input stopped (${code}). Try again.`;
  }
}

/** Joins two parts of a note with one space. */
export function appendText(before: string, add: string): string {
  const a = add.trim();
  if (!a) return before;
  if (!before.trim()) return a;
  return /\s$/.test(before) ? before + a : `${before} ${a}`;
}

export function useSpeechInput({ lang, onText, disabled = false }: { lang: string; onText: (text: string) => void; disabled?: boolean }) {
  const supported = recognizerCtor() !== null;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<SpeechRecognizer | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  /** Stops at once and drops the text that is not final (unmount, send, cancel). */
  const abort = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    r.onresult = null; r.onerror = null; r.onend = null;
    try { r.abort(); } catch { /* already stopped */ }
    setListening(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    const Ctor = recognizerCtor();
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let wait = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        const text = res[0]?.transcript ?? '';
        if (res.isFinal) onTextRef.current(text);
        else wait += text;
      }
      setInterim(wait.trim());
    };
    r.onerror = (e) => { const msg = errorText(e.error); if (msg) setError(msg); };
    r.onend = () => { if (rec.current === r) rec.current = null; setListening(false); setInterim(''); };
    rec.current = r;
    setError(null);
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
      setError('Voice input did not start. Try again.');
    }
  }, [lang]);

  /** Push again: stops, and the browser sends the last final text. */
  const toggle = useCallback(() => {
    if (rec.current) { try { rec.current.stop(); } catch { abort(); } return; }
    start();
  }, [start, abort]);

  useEffect(() => { if (disabled) abort(); }, [disabled, abort]);
  useEffect(() => abort, [abort]);

  return { supported, listening, interim, error, toggle, abort };
}

/**
 * The microphone button and the language choice for a note box. Push to start, push again to stop.
 * It stops by itself when it unmounts or when `disabled` becomes true (for example while the note is sent).
 */
export function MicButton({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const [lang, setLang] = useState(storedLang);
  const { supported, listening, interim, error, toggle } = useSpeechInput({ lang, onText, disabled });

  const pickLang = (v: string) => {
    setLang(v);
    try { localStorage.setItem(LANG_KEY, v); } catch { /* no storage */ }
  };

  const hint = 'Voice input works in Chrome or Edge. In Windows you can also press Win + H.';
  return (
    <>
      <span className="mic">
        <button
          type="button"
          className={`gr-btn mic-btn${listening ? ' mic-on' : ''}`}
          disabled={!supported || disabled}
          aria-pressed={listening}
          title={supported ? (listening ? 'Push to stop' : 'Speak the note') : hint}
          onClick={toggle}
        >
          {listening ? <><span className="mic-dot" aria-hidden="true" />Listening… push to stop</> : <>🎤 Speak</>}
        </button>
        <select
          className="mic-lang"
          aria-label="Language of the speech"
          value={lang}
          disabled={!supported || listening}
          onChange={(e) => pickLang(e.target.value)}
        >
          {VOICE_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </span>
      {(!supported || interim || error) && (
        <span className="mic-msg" role="status">
          {!supported && <span className="muted">{hint}</span>}
          {supported && interim && <span className="mic-interim" dir="auto">{interim}…</span>}
          {supported && error && <span className="error-inline">{error}</span>}
        </span>
      )}
    </>
  );
}
