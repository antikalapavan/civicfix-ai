import React, { useState, useRef, useEffect } from 'react';
import {
  Bot,
  Send,
  RotateCcw,
  Sparkles,
  Leaf,
  AlertTriangle,
  ArrowLeft,
  Droplet,
  CloudRain,
  Lightbulb,
  FileText,
  Languages,
  Globe2,
} from 'lucide-react';
import { ChatMessage } from '../types/civic';
import { CivifixLogo } from './CivifixLogo';
import { searchCivicKnowledge } from '../data/civicKnowledge';
import { useLanguage } from '../context/LanguageContext';
import { getFirebaseAuthHeaders } from '../lib/firebase';
import { getApiUrl } from '../lib/api';

export type ChatLanguageCode = 'en' | 'hi' | 'te' | 'ta' | 'kn';

export interface ChatLanguageOption {
  code: ChatLanguageCode;
  label: string;
  nativeName: string;
}

export const CHAT_LANGUAGE_OPTIONS: ChatLanguageOption[] = [
  { code: 'en', label: 'English', nativeName: 'English' },
  { code: 'hi', label: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'te', label: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'ta', label: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'kn', label: 'Kannada', nativeName: 'ಕನ್ನಡ' },
];

export interface CivicChatbotProps {
  onBack?: () => void;
  onNavigateToReport?: () => void;
  onNavigateToMyReports?: () => void;
}

interface SuggestedPrompt {
  icon: React.ReactNode;
  category: string;
  text: string;
}

const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    icon: <Leaf className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />,
    category: 'Waste Segregation',
    text: 'How do I segregate wet and dry waste?',
  },
  {
    icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />,
    category: 'Road Hazards',
    text: 'How can I report a dangerous road pothole?',
  },
  {
    icon: <Droplet className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />,
    category: 'Water Pipeline',
    text: 'What should I do if a water main is leaking?',
  },
  {
    icon: <CloudRain className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />,
    category: 'Drainage & Floods',
    text: 'How do I report blocked drains and monsoon flooding?',
  },
  {
    icon: <Lightbulb className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400" />,
    category: 'Street Lighting',
    text: 'How can I report a broken or dark street light?',
  },
  {
    icon: <FileText className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />,
    category: 'CiviFix App Guide',
    text: 'How do I track my submitted reports and status?',
  },
];

function getFollowUpChips(text: string): string[] {
  const lower = text.toLowerCase();
  if (lower.includes('pothole') || lower.includes('crater') || lower.includes('road')) {
    return [
      'How can I track my report?',
      'What if nobody fixes it?',
      'What photo should I upload?',
    ];
  }
  if (lower.includes('e-waste') || lower.includes('electronic') || lower.includes('phone')) {
    return [
      'Where can I take my old phone?',
      'What should I do before handing it over?',
      'What about its battery?',
    ];
  }
  if (lower.includes('segregat') || lower.includes('blue bin') || lower.includes('green bin') || lower.includes('dry recyclab')) {
    return [
      'What goes into the blue bin?',
      'Can I put food waste there?',
      'Can I compost it at home?',
    ];
  }
  if (lower.includes('water leak') || lower.includes('pipeline') || lower.includes('burst')) {
    return [
      'What info should I provide?',
      'What happens after submission?',
      'How do I check repair status?',
    ];
  }
  if (lower.includes('garbage') || lower.includes('dump') || lower.includes('trash') || lower.includes('overflow')) {
    return [
      'How can I report it?',
      'What photo should I take?',
      'What happens next?',
    ];
  }
  if (lower.includes('drain') || lower.includes('flood') || lower.includes('gutter')) {
    return [
      'How do I report blocked drains?',
      'How long will it take to clear?',
      'How can I track it?',
    ];
  }
  if (lower.includes('streetlight') || lower.includes('pole')) {
    return [
      'How do I report a broken streetlight?',
      'What info should I provide?',
      'How can I track it?',
    ];
  }
  return [
    'How do I report an issue?',
    'How do I track my reports?',
  ];
}

export const CivicChatbot: React.FC<CivicChatbotProps> = ({
  onBack,
  onNavigateToReport,
  onNavigateToMyReports,
}) => {
  const { language: appLanguage, t } = useLanguage();
  const CHAT_STORAGE_KEY = 'civifix_chat_history';

  // 1. Multilingual Support: Default to application language if supported, otherwise English
  const [selectedLanguage, setSelectedLanguage] = useState<ChatLanguageCode>(() => {
    if (appLanguage === 'hi') return 'hi';
    if (appLanguage === 'te') return 'te';
    return 'en';
  });

  // 2. Multi-Turn Conversation Memory: Chronological storage in sessionStorage
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const saved = sessionStorage.getItem(CHAT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore storage error
    }
    return [];
  });

  const [inputQuery, setInputQuery] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Persist messages to sessionStorage without clearing on language change
  useEffect(() => {
    try {
      if (messages.length > 0) {
        sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
      } else {
        sessionStorage.removeItem(CHAT_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [messages]);

  // Auto scroll to latest message or typing indicator
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Language switch handler: Updates language state without clearing conversation history
  const handleLanguageChange = (newLanguage: ChatLanguageCode) => {
    setSelectedLanguage(newLanguage);
  };

  const handleSend = async (textToSend?: string) => {
    const query = (textToSend || inputQuery).trim();
    if (!query || isTyping) return;

    setErrorMessage(null);

    const userMsg: ChatMessage = {
      id: 'usr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      sender: 'user',
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    // Append user message to conversation immediately
    setMessages((prev) => [...prev, userMsg]);
    setInputQuery('');
    setIsTyping(true);

    try {
      // Format history with standard Gemini roles ('user' and 'model')
      const historyPayload = messages.slice(-10).map((m) => ({
        role: m.sender === 'user' ? ('user' as const) : ('model' as const),
        text: m.text,
      }));

      const authHeaders = await getFirebaseAuthHeaders();
      const res = await fetch(getApiUrl('/api/gemini/chat'), {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: query,
          history: historyPayload,
          language: selectedLanguage,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const replyText = data.reply;
      const isFallback = Boolean(data.isFallback);

      if (!replyText || typeof replyText !== 'string') {
        throw new Error('Invalid response received from assistant server.');
      }

      const aiMsg: ChatMessage = {
        id: 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        sender: 'assistant',
        text: replyText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isFallback,
        fallbackTopic: data.fallbackTopic,
        suggestedAction: data.suggestedAction,
      };

      setMessages((prev) => [...prev, aiMsg]);
    } catch {
      // Intelligent offline civic knowledge fallback
      const matched = searchCivicKnowledge(query, messages);

      let fallbackReply = matched
        ? matched.answer
        : `I am the CiviFix Civic Assistant.\n\nYou can report civic issues (garbage overflow, road potholes, water leaks, blocked stormwater drains, broken streetlights) directly via the "+ Report" screen with a photo and location.`;

      if (selectedLanguage !== 'en') {
        const localizedNotices: Record<string, string> = {
          hi: '\n\n[नोट: यह CiviFix नागरिक ज्ञानकोश से ऑफलाइन उत्तर है।]',
          te: '\n\n[గమనిక: ఇది CiviFix పౌర నాలెಡ್జ్ బేస్ నుండి ఆఫ్‌లైన్ సమాధానం.]',
          ta: '\n\n[குறிப்பு: இது CiviFix குடிமை அறிவுத்தளத்தின் ஆஃப்லைன் பதில்.]',
          kn: '\n\n[ಗಮನಿಸಿ: ಇದು CiviFix ನಾಗರಿಕ ಜ್ಞಾನಕೋಶದಿಂದ ಆಫ್‌ಲೈನ್ ಉತ್ತರವಾಗಿದೆ.]',
        };
        if (localizedNotices[selectedLanguage]) {
          fallbackReply += localizedNotices[selectedLanguage];
        }
      }

      const aiMsg: ChatMessage = {
        id: 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        sender: 'assistant',
        text: fallbackReply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isFallback: true,
        fallbackTopic: matched ? matched.title : 'Civic Knowledge Base',
        suggestedAction: matched?.suggestedAction,
      };

      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setIsTyping(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleResetConversation = () => {
    setMessages([]);
    setInputQuery('');
    setErrorMessage(null);
    setShowResetConfirm(false);
    try {
      sessionStorage.removeItem(CHAT_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  return (
    <div className="bg-[#F8FAF7] dark:bg-[#0c1322] h-[calc(100dvh-8rem)] md:h-[calc(100dvh-4rem)] w-full flex flex-col justify-between text-slate-900 dark:text-slate-100 select-none overflow-hidden transition-colors">
      {/* Top Chat Subheader with Language Dropdown & Reset Action */}
      <div className="bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/90 dark:border-slate-800/90 shrink-0 shadow-2xs">
        <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="p-1.5 -ml-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                aria-label="Back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}

            <div className="w-8 h-8 rounded-full bg-emerald-700 flex items-center justify-center text-white shadow-xs shrink-0 ring-2 ring-emerald-100 dark:ring-emerald-900/60">
              <Bot className="w-4 h-4 text-emerald-100" />
            </div>

            <div className="min-w-0">
              <h1 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white leading-tight truncate">
                {t('civicAi.title')}
              </h1>
              <p className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 leading-none mt-0.5 truncate">
                {t('civicAi.subtitle')}
              </p>
            </div>
          </div>

        {/* Header Right: Multilingual Selector & Reset */}
        <div className="flex items-center gap-1.5">
          {/* Language Dropdown */}
          <div className="relative flex items-center">
            <Globe2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 absolute left-2 pointer-events-none" />
            <select
              value={selectedLanguage}
              onChange={(e) => handleLanguageChange(e.target.value as ChatLanguageCode)}
              aria-label="Select conversation language"
              className="appearance-none bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-[11px] font-semibold pl-7 pr-3 py-1 rounded-xl border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer transition-colors"
            >
              {CHAT_LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>
                  {opt.nativeName}
                </option>
              ))}
            </select>
          </div>

          {/* Reset Chat History */}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="p-1.5 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex items-center cursor-pointer"
              title={t('civicAi.resetChat')}
              aria-label={t('civicAi.resetChat')}
            >
              <RotateCcw className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            </button>
          )}
        </div>
        </div>
      </div>

      {/* Reset Confirmation Overlay */}
      {showResetConfirm && (
        <div className="bg-amber-50 dark:bg-amber-950/80 border-b border-amber-200 dark:border-amber-900/60 shrink-0 animate-fadeIn">
          <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-2 flex items-center justify-between text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>{t('civicAi.resetConfirm')}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="text-slate-600 dark:text-slate-400 hover:underline text-[11px] font-semibold cursor-pointer"
              >
                {t('action.cancel')}
              </button>
              <button
                type="button"
                onClick={handleResetConversation}
                className="px-2.5 py-0.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[11px] font-bold transition-colors cursor-pointer shadow-2xs"
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Chat Scrollable Content Area */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        <div className="max-w-4xl mx-auto w-full min-h-full flex flex-col justify-between">
        {messages.length === 0 ? (
          /* Empty / Initial State with Clear Persona & Helpful Prompts */
          <div className="flex-1 flex flex-col items-center justify-center text-center my-auto py-4">
            <div className="mb-2">
              <CivifixLogo className="w-12 h-12" />
            </div>

            <div className="w-14 h-14 rounded-2xl bg-emerald-700 flex items-center justify-center text-white shadow-md shadow-emerald-900/15 mb-3 ring-4 ring-emerald-100 dark:ring-emerald-900/50">
              <Bot className="w-8 h-8 text-emerald-100" />
            </div>

            {/* Assistant Welcome Card */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 sm:p-5 shadow-2xs max-w-md mb-5">
              <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white mb-1">
                Hello, Citizen!
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                I am your <strong>CiviFix Civic Assistant</strong>. Ask questions in English, हिन्दी, తెలుగు, தமிழ், or ಕನ್ನಡ.
              </p>
            </div>

            {/* Categorized Suggested Prompts Grid */}
            <div className="w-full max-w-2xl text-left">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  {t('civicAi.suggestedQuestions')}
                </span>
                <span className="text-[10px] text-slate-400">Tap to ask</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {SUGGESTED_PROMPTS.map((prompt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSend(prompt.text)}
                    className="w-full bg-white dark:bg-slate-900 hover:bg-emerald-50/70 dark:hover:bg-slate-800 active:bg-emerald-100/60 border border-slate-200/80 dark:border-slate-800 hover:border-emerald-300 dark:hover:border-emerald-700 rounded-xl p-2.5 flex items-center gap-2.5 text-left transition-all cursor-pointer shadow-2xs"
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center shrink-0 border border-slate-100 dark:border-slate-700">
                      {prompt.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="text-[10px] font-bold text-emerald-800 dark:text-emerald-400 uppercase tracking-wider block">
                        {prompt.category}
                      </span>
                      <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate block">
                        {prompt.text}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* Active Chat Conversation History */
          <div className="space-y-3.5 pb-2">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {/* Assistant Bot Avatar */}
                {msg.sender === 'assistant' && (
                  <div className="w-7 h-7 rounded-full bg-emerald-700 flex items-center justify-center text-white shrink-0 shadow-2xs mt-1 ring-2 ring-emerald-100">
                    <Bot className="w-3.5 h-3.5" />
                  </div>
                )}

                <div
                  className={`max-w-[85%] md:max-w-[75%] rounded-2xl px-4 py-3 text-xs sm:text-sm leading-relaxed ${
                    msg.sender === 'user'
                      ? 'bg-[#059669] text-white rounded-br-xs shadow-xs'
                      : 'bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 text-slate-800 dark:text-slate-100 rounded-bl-xs shadow-2xs'
                  }`}
                >
                  {/* Sender Label for Assistant */}
                  {msg.sender === 'assistant' && (
                    <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-[10px] font-bold text-emerald-800 dark:text-emerald-400">
                        {t('civicAi.title')}
                      </span>
                      {msg.isFallback ? (
                        <span className="text-[9px] font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/70 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800 flex items-center gap-1">
                          Civic Guide
                        </span>
                      ) : (
                        <span className="text-[9px] font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/70 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800 flex items-center gap-1">
                          <Sparkles className="w-2.5 h-2.5 text-emerald-600 dark:text-emerald-400" />
                          Civic Assistant
                        </span>
                      )}
                    </div>
                  )}

                  {/* Message Content */}
                  <div className="whitespace-pre-line leading-relaxed">{msg.text}</div>

                  {/* Timestamp */}
                  <div
                    className={`text-[9px] mt-1.5 ${
                      msg.sender === 'user' ? 'text-emerald-100 text-right' : 'text-slate-400'
                    }`}
                  >
                    {msg.timestamp}
                  </div>

                  {/* Action Shortcuts for Assistant Advice */}
                  {msg.sender === 'assistant' && msg.suggestedAction && (
                    <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
                      {msg.suggestedAction === 'report' && onNavigateToReport && (
                        <button
                          type="button"
                          onClick={onNavigateToReport}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] transition shadow-xs cursor-pointer flex items-center gap-1"
                        >
                          <span>+ Go to Report Issue</span>
                        </button>
                      )}
                      {msg.suggestedAction === 'my_reports' && onNavigateToMyReports && (
                        <button
                          type="button"
                          onClick={onNavigateToMyReports}
                          className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] transition shadow-xs cursor-pointer flex items-center gap-1"
                        >
                          <span>View My Reports</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Typing Indicator */}
            {isTyping && (
              <div className="flex gap-2.5 items-center justify-start animate-pulse">
                <div className="w-7 h-7 rounded-full bg-emerald-700 flex items-center justify-center text-white shrink-0 shadow-2xs ring-2 ring-emerald-100">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl px-4 py-2.5 rounded-bl-xs shadow-2xs flex items-center gap-1.5 text-xs text-slate-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce" />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce"
                    style={{ animationDelay: '0.2s' }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce"
                    style={{ animationDelay: '0.4s' }}
                  />
                  <span className="text-[11px] ml-1">Finding civic guidance...</span>
                </div>
              </div>
            )}

            {/* Dynamic Follow-Up Question Chips */}
            {!isTyping && messages.length > 0 && messages[messages.length - 1].sender === 'assistant' && (
              <div className="pt-2 pl-9">
                <div className="flex items-center gap-1 text-[10px] font-bold text-slate-400 mb-1.5">
                  <Sparkles className="w-3 h-3 text-emerald-600" />
                  <span>Suggested follow-up:</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {getFollowUpChips(messages[messages.length - 1].text).map((chip, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleSend(chip)}
                      className="text-[11px] bg-white dark:bg-slate-900 hover:bg-emerald-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 hover:text-emerald-700 dark:hover:text-emerald-400 border border-slate-200 dark:border-slate-700 px-2.5 py-1 rounded-xl transition shadow-2xs cursor-pointer text-left"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div ref={scrollRef} />
          </div>
        )}
        </div>
      </div>

      {/* Bottom Message Input Bar */}
      <div className="bg-white dark:bg-slate-950 border-t border-slate-200/90 dark:border-slate-800 px-4 sm:px-6 py-3 shrink-0">
        <div className="max-w-4xl mx-auto w-full">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            disabled={isTyping}
            placeholder={
              selectedLanguage === 'hi'
                ? 'नागरिक समस्या या नियम पूछें...'
                : selectedLanguage === 'te'
                ? 'పౌర సమస్య లేదా మార్గదర్శకం అడగండి...'
                : selectedLanguage === 'ta'
                ? 'குடிமைப் பிரச்சினை அல்லது வழிகாட்டலைக் கேளுங்கள்...'
                : selectedLanguage === 'kn'
                ? 'ನಾಗರಿಕ ಸಮಸ್ಯೆ ಅಥವಾ ಮಾರ್ಗದರ್ಶನವನ್ನು ಕೇಳಿ...'
                : t('civicAi.inputPlaceholder')
            }
            className="flex-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-60 transition"
          />

          <button
            type="submit"
            disabled={!inputQuery.trim() || isTyping}
            className="w-10 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm cursor-pointer shrink-0"
            aria-label="Send Message"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
          <span>Civic Assistant · Municipal Guidance</span>
          <span>{CHAT_LANGUAGE_OPTIONS.find((l) => l.code === selectedLanguage)?.nativeName}</span>
        </div>
        </div>
      </div>
    </div>
  );
};
