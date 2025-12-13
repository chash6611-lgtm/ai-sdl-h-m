
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { QuizQuestion, Grade, ShortAnswerEvaluation } from '../types.ts';
import { Card } from './common/Card.tsx';
import { Button } from './common/Button.tsx';
import { Spinner } from './common/Spinner.tsx';
import { generateSpeech, evaluateShortAnswer, preprocessLaTeX } from '../services/geminiService.ts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

interface QuizProps {
    questions: QuizQuestion[];
    onSubmit: (
        score: number, 
        correctAnswers: number, 
        totalQuestions: number,
        userAnswers: (string | null)[],
        correctness: (boolean | null)[]
    ) => void;
}

// Helper functions for audio decoding (Local to Quiz to minimize external dependencies for now)
function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
): Promise<AudioBuffer> {
    const frameCount = data.length / 2; // 16-bit PCM
    const buffer = ctx.createBuffer(1, frameCount, 24000);
    const channelData = buffer.getChannelData(0);
    const dataInt16 = new Int16Array(data.buffer);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i] / 32768.0;
    }
    return buffer;
}

// Helper to compare answers robustly (handles trailing dots, whitespace, and index matching)
const isAnswerMatch = (option: string | null, answer: string, optionIndex: number, allOptions: string[] = []) => {
    if (!option) return false;
    
    // Normalize: remove all whitespace and trailing punctuation, lowercase
    const normalize = (str: string) => str.replace(/\s+/g, '').replace(/[.,]$/, '').toLowerCase();
    const normOption = normalize(option);
    const normAnswer = normalize(answer);
    
    // 1. Direct Content Match
    if (normOption === normAnswer) return true;

    // Check if strict content matching should be enforced
    // If any option matches the answer exactly (normalized), we assume the answer refers to content, NOT index.
    // This prevents "1" (answer) matching Option 1 (index 0, content "0") when Option 2 is actually "1".
    const strictContentMatchExists = allOptions.some(opt => normalize(opt) === normAnswer);

    if (strictContentMatchExists) {
        return false; // Since direct match failed above, and we know a direct match exists elsewhere, this must be false.
    }

    // 2. Index / Circled Number Match (Fallback only if no strict content match exists)
    const indexStr = (optionIndex + 1).toString();
    const circledNumbers = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    const circledNumber = circledNumbers[optionIndex];

    // Check if answer IS the index/circled number
    if (normAnswer === indexStr) return true;
    if (circledNumber && normAnswer === circledNumber) return true;
    
    // Check if answer STARTS WITH or INCLUDES the index/circled number
    // (e.g. Answer: "③ y=-x^2+3x" or "3. Content")
    if (normAnswer.startsWith(indexStr + '.') || normAnswer.startsWith(indexStr + ')')) return true;
    if (normAnswer.startsWith('(' + indexStr + ')')) return true;
    if (circledNumber && normAnswer.includes(circledNumber)) return true;

    return false;
};

const SpeakerIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
    </svg>
);

const StopIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
     <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <rect x="6" y="6" width="12" height="12"></rect>
    </svg>
);

const ScriptIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
    </svg>
);

const TranslateIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M5 8l6 6"></path>
        <path d="M4 14l6-6 2-3"></path>
        <path d="M2 5h12"></path>
        <path d="M7 2h1"></path>
        <path d="M22 22l-5-10-5 10"></path>
        <path d="M14 18h6"></path>
    </svg>
);

export const Quiz: React.FC<QuizProps> = ({ questions, onSubmit }) => {
    // Safety check: ensure questions exist and are not empty
    const safeQuestions = questions || [];
    const hasQuestions = safeQuestions.length > 0;

    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [userAnswers, setUserAnswers] = useState<(string | null)[]>(hasQuestions ? Array(safeQuestions.length).fill(null) : []);
    
    // Manage checked state for EACH question individually
    const [checkedStates, setCheckedStates] = useState<boolean[]>(hasQuestions ? Array(safeQuestions.length).fill(false) : []);
    
    const [showResults, setShowResults] = useState(false);
    const [tempShortAnswer, setTempShortAnswer] = useState('');
    
    // New States for Short Answer Grading
    const [shortAnswerGrades, setShortAnswerGrades] = useState<(Grade | null)[]>(hasQuestions ? Array(safeQuestions.length).fill(null) : []);
    const [aiEvaluations, setAiEvaluations] = useState<(ShortAnswerEvaluation | null)[]>(hasQuestions ? Array(safeQuestions.length).fill(null) : []);
    const [isAiGrading, setIsAiGrading] = useState(false);

    // Audio / Script / Translation State
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isLoadingTTS, setIsLoadingTTS] = useState(false);
    const [showScript, setShowScript] = useState(false);
    const [showTranslation, setShowTranslation] = useState(false); // Default hidden
    const audioContextRef = useRef<AudioContext | null>(null);
    const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
    
    // Refs and Constants for Math Input
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const mathSymbols = [
        // Basic Ops
        { label: '분수', insert: '$\\frac{}{}$', move: -4 },
        { label: '×', insert: '$\\times$', move: 0 },
        { label: '÷', insert: '$\\div$', move: 0 },
        { label: '±', insert: '$\\pm$', move: 0 },
        { label: '≠', insert: '$\\ne$', move: 0 },
        { label: '≤', insert: '$\\le$', move: 0 },
        { label: '≥', insert: '$\\ge$', move: 0 },
        { label: '≈', insert: '$\\approx$', move: 0 },
        { label: '( )', insert: '$()$', move: -2 },

        // Powers/Roots
        { label: 'x²', insert: '$x^2$', move: 0 },
        { label: 'xⁿ', insert: '$x^{}$', move: -2 },
        { label: '□ⁿ', insert: '$^{}$', move: -4 },
        { label: '√', insert: '$\\sqrt{}$', move: -2 },

        // Functions / Limits
        { label: '∞', insert: '$\\infty$', move: 0 },
        { label: 'lim', insert: '$\\lim_{x \\to }$', move: -2 },
        { label: 'f⁻¹', insert: '$f^{-1}(x)$', move: 0 },
        { label: 'g∘f', insert: '$(g \\circ f)(x)$', move: 0 },

        // Calculus
        { label: "f'", insert: "$f'(x)$", move: 0 },
        { label: "y'", insert: "$\\frac{dy}{dx}$", move: 0 },
        { label: '∫', insert: '$\\int$', move: 0 },
        { label: '∫aᵇ', insert: '$\\int_{a}^{b}$', move: 0 },
        { label: '∇', insert: '$\\nabla$', move: 0 },

        // Geometry / Vectors
        { label: '∠', insert: '$\\angle$', move: 0 },
        { label: '△', insert: '$\\triangle$', move: 0 },
        { label: 'a⃗', insert: '$\\vec{a}$', move: 0 },
        { label: 'AB⟶', insert: '$\\overrightarrow{AB}$', move: 0 },
        { label: '|a⃗|', insert: '$|\\vec{a}|$', move: 0 },
        { label: '·', insert: '$\\cdot$', move: 0 },

        // Sequences
        { label: '∑', insert: '$\\sum_{k=1}^{n}$', move: 0 },
        { label: '∏', insert: '$\\prod_{k=1}^{n}$', move: 0 },

        // Complex Numbers
        { label: 'i', insert: '$i$', move: 0 },
        { label: 'z̄', insert: '$\\bar{z}$', move: 0 },
        { label: '|z|', insert: '$|z|$', move: 0 },
        
        // Probability / Stats
        { label: 'P(B|A)', insert: '$P(B|A)$', move: 0 },
        { label: 'E(X)', insert: '$E(X)$', move: 0 },
        { label: 'V(X)', insert: '$V(X)$', move: 0 },
        { label: 'σ', insert: '$\\sigma$', move: 0 },
        { label: 'nCk', insert: '$\\binom{n}{k}$', move: 0 },

        // Sets
        { label: '∈', insert: '$\\in$', move: 0 },
        { label: '⊂', insert: '$\\subset$', move: 0 },
        { label: '∪', insert: '$\\cup$', move: 0 },
        { label: '∩', insert: '$\\cap$', move: 0 },
        { label: '∅', insert: '$\\emptyset$', move: 0 },

        // Constants/Greek
        { label: 'π', insert: '$\\pi$', move: 0 },
        { label: 'θ', insert: '$\\theta$', move: 0 },
        { label: '°', insert: '$^\\circ$', move: 0 },
        { label: '→', insert: '$\\rightarrow$', move: 0 },
    ];

    useEffect(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // Stop audio when changing questions
        stopAudio();
        setShowScript(false);
        // We keep showTranslation state as is (user might want to keep it on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentQuestionIndex]);
    
    // Sync tempShortAnswer with saved user answer when navigating
    useEffect(() => {
        if (!hasQuestions) return;
        const savedAnswer = userAnswers[currentQuestionIndex];
        const currentQType = safeQuestions[currentQuestionIndex].questionType;
        
        if (currentQType !== 'multiple-choice' && currentQType !== 'ox') {
             setTempShortAnswer(savedAnswer || '');
        } else {
             setTempShortAnswer('');
        }
    }, [currentQuestionIndex, userAnswers, checkedStates, safeQuestions, hasQuestions]);

    const stopAudio = useCallback(() => {
        if (audioSourceRef.current) {
            try {
                audioSourceRef.current.onended = null;
                audioSourceRef.current.stop();
            } catch (e) {
                console.warn("Audio stop error:", e);
            }
            audioSourceRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            audioContextRef.current.close().then(() => {
                audioContextRef.current = null;
            });
        }
        setIsSpeaking(false);
        setIsLoadingTTS(false);
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => stopAudio();
    }, [stopAudio]);
    
    if (!hasQuestions) {
        return <div className="p-8 text-center text-red-500 bg-white dark:bg-slate-800 rounded-xl shadow">문제 데이터가 없습니다. 다시 시도해주세요.</div>;
    }

    const currentQuestion = safeQuestions[currentQuestionIndex];

    const handlePlayScript = async (text: string) => {
        if (isSpeaking || isLoadingTTS) {
            stopAudio();
            return;
        }
        
        setIsLoadingTTS(true);
        try {
            // Use 'Zephyr' (British/International sounding male) for reading passages clearly
            const base64Audio = await generateSpeech(text, 'Zephyr');

            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            audioContextRef.current = audioCtx;
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            const audioBytes = decode(base64Audio);
            const audioBuffer = await decodeAudioData(audioBytes, audioCtx);
            
            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);
            audioSourceRef.current = source;
            
            source.onended = () => {
                stopAudio();
            };

            source.start();
            setIsLoadingTTS(false);
            setIsSpeaking(true);

        } catch (err) {
            console.error(err);
            alert("오디오 재생 중 오류가 발생했습니다.");
            stopAudio();
        }
    };


    const userAnswer = userAnswers[currentQuestionIndex];
    const isAnswerChecked = checkedStates[currentQuestionIndex];

    const handleAnswerSelect = (option: string) => {
        if (isAnswerChecked) return;
        const newAnswers = [...userAnswers];
        newAnswers[currentQuestionIndex] = option;
        setUserAnswers(newAnswers);
    };
    
    const handleShortAnswerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (isAnswerChecked) return;
        setTempShortAnswer(e.target.value);
    };

    const insertMathSymbol = (insert: string, move: number) => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        
        const newText = text.substring(0, start) + insert + text.substring(end);
        setTempShortAnswer(newText);
        
        setTimeout(() => {
            textarea.focus();
            const newCursor = start + insert.length + move;
            textarea.setSelectionRange(newCursor, newCursor);
        }, 0);
    };

    const handleCheckAnswer = () => {
        // If it's short-answer (or treated as such), save the temp answer to main state
        const type = currentQuestion.questionType;
        const isMcOrOx = type === 'multiple-choice' || type === 'ox';
        
        if (!isMcOrOx) {
            const newAnswers = [...userAnswers];
            newAnswers[currentQuestionIndex] = tempShortAnswer;
            setUserAnswers(newAnswers);
        }
        
        const newCheckedStates = [...checkedStates];
        newCheckedStates[currentQuestionIndex] = true;
        setCheckedStates(newCheckedStates);
        setShowScript(true); // Auto show script on check answer for review
    };

    // AI Grading Handler
    const handleAiGrading = async () => {
        setIsAiGrading(true);
        try {
            const result = await evaluateShortAnswer(
                currentQuestion.question,
                currentQuestion.answer,
                userAnswers[currentQuestionIndex] || ''
            );
            const newAiEvaluations = [...aiEvaluations];
            newAiEvaluations[currentQuestionIndex] = result;
            setAiEvaluations(newAiEvaluations);
        } catch (error) {
            alert('AI 채점 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.');
        } finally {
            setIsAiGrading(false);
        }
    };

    // Manual Grading Handler
    const handleGradeSelection = (grade: Grade) => {
        const newGrades = [...shortAnswerGrades];
        newGrades[currentQuestionIndex] = grade;
        setShortAnswerGrades(newGrades);
    };
    
    const handlePrev = () => {
        if (currentQuestionIndex > 0) {
            setCurrentQuestionIndex(prev => prev - 1);
        }
    };

    const handleNext = () => {
        if (currentQuestionIndex < safeQuestions.length - 1) {
            setCurrentQuestionIndex(prev => prev + 1);
        } else {
            // Calculate final results
            let totalEarnedPoints = 0;
            const calculatedCorrectness = safeQuestions.map((question, index) => {
                 const type = question.questionType;
                 const isMcOrOx = type === 'multiple-choice' || type === 'ox';
                 const ans = userAnswers[index];
                 
                 if (!isMcOrOx) {
                     const grade = shortAnswerGrades[index];
                     if (grade === 'A') {
                         totalEarnedPoints += 1;
                         return true;
                     } else if (grade === 'B') {
                         totalEarnedPoints += 0.75;
                         return true; // 75%
                     } else if (grade === 'C') {
                         totalEarnedPoints += 0.5;
                         return true; // 50%
                     } else if (grade === 'D') {
                         totalEarnedPoints += 0.25;
                         return false; // 25% considered incorrect for binary stat
                     } else {
                         return false;
                     }
                 } else {
                     // Let's find the index of the user answer in the options
                     const options = question.options || [];
                     const selectedIndex = options.findIndex(opt => opt === ans);
                     
                     if (selectedIndex !== -1) {
                         // Check if this index matches the answer string
                         return isAnswerMatch(ans, question.answer, selectedIndex, options);
                     }
                     
                     // Fallback to direct string match
                     const isCorrect = isAnswerMatch(ans, question.answer, -1, options);
                     if (isCorrect) totalEarnedPoints += 1;
                     return isCorrect;
                 }
            });

            const scorePercentage = (totalEarnedPoints / safeQuestions.length) * 100;
            const correctCount = calculatedCorrectness.filter(c => c === true).length;
            
            setShowResults(true);
            onSubmit(scorePercentage, correctCount, safeQuestions.length, userAnswers, calculatedCorrectness);
        }
    };

    const isLastQuestion = currentQuestionIndex === safeQuestions.length - 1;

    const getOptionClasses = (option: string, index: number) => {
        let baseClasses = 'w-full text-left p-3 border rounded-lg transition-all duration-200 select-none text-sm leading-snug';
        const options = currentQuestion.options || [];

        if (!isAnswerChecked) {
            if (userAnswer === option) {
                return `${baseClasses} bg-neon-blue/20 border-neon-blue ring-2 ring-neon-blue cursor-pointer font-medium dark:text-slate-100`;
            }
            return `${baseClasses} bg-white dark:bg-slate-700 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-600 active:bg-slate-100 dark:active:bg-slate-500 cursor-pointer dark:text-slate-200`;
        }

        const isCorrectAnswer = isAnswerMatch(option, currentQuestion.answer, index, options);
        const isSelectedAnswer = option === userAnswer;

        if (isCorrectAnswer) {
            return `${baseClasses} bg-lime-green/20 border-lime-green ring-2 ring-lime-green cursor-default dark:text-slate-100`;
        }
        if (isSelectedAnswer) {
            return `${baseClasses} bg-red-100 dark:bg-red-900/30 border-red-500 ring-2 ring-red-500 cursor-default dark:text-slate-100`;
        }
        return `${baseClasses} bg-slate-50 dark:bg-slate-700/50 border-slate-300 dark:border-slate-600 text-slate-400 dark:text-slate-500 cursor-default opacity-60`;
    };
    
    if (showResults) {
      return null;
    }
    
    const markdownComponents = {
        table: (props: any) => <div className="overflow-x-auto mb-2"><table className="table-auto w-full border-collapse border border-slate-300 dark:border-slate-600" {...props} /></div>,
        thead: (props: any) => <thead className="bg-slate-100 dark:bg-slate-700" {...props} />,
        th: (props: any) => <th className="border border-slate-300 dark:border-slate-600 px-2 py-1 text-left whitespace-nowrap text-xs sm:text-sm" {...props} />,
        td: (props: any) => <td className="border border-slate-300 dark:border-slate-600 px-2 py-1 text-xs sm:text-sm min-w-[80px]" {...props} />,
        p: (props: any) => <p className="mb-0" {...props} />, 
    };

    const renderQuestionInput = () => {
        const type = currentQuestion.questionType;
        const isOx = type === 'ox';
        const isMc = type === 'multiple-choice';

        if (isMc || isOx) {
            let options = currentQuestion.options;
            // Ensure OX questions always have options if not provided
            if (isOx && (!options || options.length === 0)) {
                options = ['O', 'X'];
            }
            
            if (!options || options.length === 0) {
                 return <div className="text-red-500 text-sm">옵션을 불러올 수 없습니다.</div>;
            }

            return (
                <div className="space-y-2 mt-4">
                    {options.map((option, index) => {
                        const isCorrectAnswer = isAnswerMatch(option, currentQuestion.answer, index, options);
                        const showCorrectLabel = isAnswerChecked && isCorrectAnswer;
                        const optionTranslation = currentQuestion.optionsTranslation?.[index];

                        return (
                            <div key={index} className="relative">
                                {showCorrectLabel && (
                                    <div className="absolute -top-2 right-2 bg-lime-green text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full z-10 shadow-sm">
                                        정답
                                    </div>
                                )}
                                <button
                                    onClick={() => handleAnswerSelect(option)}
                                    className={getOptionClasses(option, index)}
                                    disabled={isAnswerChecked}
                                >
                                    <div className="overflow-x-auto">
                                        <ReactMarkdown 
                                            remarkPlugins={[remarkGfm, remarkMath]}
                                            rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                            components={markdownComponents}
                                        >
                                            {preprocessLaTeX(option)}
                                        </ReactMarkdown>
                                    </div>
                                    {/* Translation for Option */}
                                    {showTranslation && optionTranslation && (
                                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-normal">
                                            <ReactMarkdown 
                                                remarkPlugins={[remarkGfm, remarkMath]}
                                                rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                                components={markdownComponents}
                                            >
                                                {preprocessLaTeX(optionTranslation)}
                                            </ReactMarkdown>
                                        </div>
                                    )}
                                </button>
                            </div>
                        );
                    })}
                     {/* Explicit Answer Display for MC/OX when checked */}
                    {isAnswerChecked && (
                        <div className="mt-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-200 dark:border-slate-600">
                             <p className="font-semibold text-slate-800 dark:text-slate-200 mb-1.5 text-sm">
                                정답:
                            </p>
                            <div className="text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 p-2 rounded border border-slate-200 dark:border-slate-600 text-sm">
                                <ReactMarkdown 
                                    remarkPlugins={[remarkGfm, remarkMath]}
                                    rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                    components={markdownComponents}
                                >
                                    {preprocessLaTeX(currentQuestion.answer)}
                                </ReactMarkdown>
                            </div>
                             {showTranslation && currentQuestion.answerTranslation && (
                                <div className="mt-1 text-slate-500 dark:text-slate-400 text-xs p-2">
                                    <span className="font-semibold mr-1">한글:</span>
                                    {currentQuestion.answerTranslation}
                                </div>
                            )}

                            {/* Explanation for MC/OX */}
                            <p className="font-semibold text-slate-800 dark:text-slate-200 mb-1.5 text-sm mt-3 pt-3 border-t border-slate-200 dark:border-slate-600">
                                해설:
                            </p>
                            <div className="text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 p-2 rounded border border-slate-200 dark:border-slate-600 text-sm">
                                <ReactMarkdown 
                                    remarkPlugins={[remarkGfm, remarkMath]}
                                    rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                    components={markdownComponents}
                                >
                                    {preprocessLaTeX(currentQuestion.explanation)}
                                </ReactMarkdown>
                            </div>
                            {showTranslation && currentQuestion.explanationTranslation && (
                                <div className="mt-1 text-slate-500 dark:text-slate-400 text-xs p-2">
                                    <span className="font-semibold mr-1">한글:</span>
                                    {currentQuestion.explanationTranslation}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            );
        }

        // Short-answer UI (for both 'short-answer' and 'creativity')
        return (
            <div className="mt-4">
                {/* Math Symbol Toolbar */}
                <div className="flex gap-1.5 mb-2 overflow-x-auto pb-1 items-center scrollbar-hide">
                    {mathSymbols.map((item, idx) => (
                        <button
                            key={idx}
                            type="button"
                            onClick={() => insertMathSymbol(item.insert, item.move)}
                            className="flex-shrink-0 px-2.5 py-1.5 bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded text-xs sm:text-sm font-medium hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors text-slate-700 dark:text-slate-200"
                            title={item.insert}
                            disabled={isAnswerChecked}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                <textarea
                    ref={textareaRef}
                    value={tempShortAnswer}
                    onChange={handleShortAnswerChange}
                    disabled={isAnswerChecked}
                    className="w-full p-3 border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 rounded-lg focus:ring-2 focus:ring-neon-blue text-base text-slate-800 dark:text-slate-100"
                    placeholder={type === 'creativity' ? "창의적인 답변을 자유롭게 작성해보세요..." : "정답을 입력하세요..."}
                    rows={2}
                />
                
                {tempShortAnswer.trim() && (
                    <div className="mt-2 p-3 bg-slate-50 dark:bg-slate-700/30 rounded-lg border border-slate-200 dark:border-slate-600">
                        <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">수식 미리보기</p>
                        <div className="prose prose-sm dark:prose-invert max-w-none text-slate-800 dark:text-slate-100">
                            <ReactMarkdown 
                                remarkPlugins={[remarkGfm, remarkMath]} 
                                rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                components={markdownComponents}
                            >
                                {preprocessLaTeX(tempShortAnswer)}
                            </ReactMarkdown>
                        </div>
                    </div>
                )}

                {isAnswerChecked && (
                    <div className="mt-4 p-3 sm:p-4 rounded-lg bg-slate-50 dark:bg-slate-700/30 border border-slate-200 dark:border-slate-600">
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mb-1.5 text-sm">
                            {type === 'creativity' ? 'AI가 제시한 모범 답안 예시:' : 'AI가 제시한 정답:'}
                        </p>
                        <div className="text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 p-2 rounded border border-slate-200 dark:border-slate-600 text-sm">
                            <ReactMarkdown 
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                components={markdownComponents}
                            >
                                {preprocessLaTeX(currentQuestion.answer)}
                            </ReactMarkdown>
                        </div>
                        {/* Translation for Answer */}
                        {showTranslation && currentQuestion.answerTranslation && (
                            <div className="mt-1 text-slate-500 dark:text-slate-400 text-xs p-2">
                                <span className="font-semibold mr-1">한글:</span>
                                {currentQuestion.answerTranslation}
                            </div>
                        )}
                        
                        {/* Explanation for Short Answer/Creativity */}
                        <p className="font-semibold text-slate-800 dark:text-slate-200 mb-1.5 text-sm mt-3 pt-3 border-t border-slate-200 dark:border-slate-600">
                            해설:
                        </p>
                        <div className="text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 p-2 rounded border border-slate-200 dark:border-slate-600 text-sm">
                            <ReactMarkdown 
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                components={markdownComponents}
                            >
                                {preprocessLaTeX(currentQuestion.explanation)}
                            </ReactMarkdown>
                        </div>
                        {showTranslation && currentQuestion.explanationTranslation && (
                            <div className="mt-1 text-slate-500 dark:text-slate-400 text-xs p-2">
                                <span className="font-semibold mr-1">한글:</span>
                                {currentQuestion.explanationTranslation}
                            </div>
                        )}

                        <div className="mt-4 border-t border-slate-200 dark:border-slate-600 pt-4">
                            <p className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-2">채점하기</p>
                            
                            {/* AI Grading Section */}
                            <div className="mb-4">
                                {!aiEvaluations[currentQuestionIndex] ? (
                                    <Button 
                                        variant="secondary" 
                                        onClick={handleAiGrading} 
                                        disabled={isAiGrading}
                                        className="text-xs !py-1.5 !px-3"
                                    >
                                        {isAiGrading ? <Spinner size="sm" /> : '🤖 AI 채점 결과 보기'}
                                    </Button>
                                ) : (
                                    <div className="bg-white dark:bg-slate-800 p-3 rounded-lg border border-slate-200 dark:border-slate-600 text-sm">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="font-bold text-neon-blue">AI 점수:</span>
                                            <span className={`font-bold px-2 py-0.5 rounded text-xs ${
                                                aiEvaluations[currentQuestionIndex]!.grade === 'A' ? 'bg-green-100 text-green-700' :
                                                aiEvaluations[currentQuestionIndex]!.grade === 'B' ? 'bg-blue-100 text-blue-700' :
                                                aiEvaluations[currentQuestionIndex]!.grade === 'C' ? 'bg-yellow-100 text-yellow-700' :
                                                aiEvaluations[currentQuestionIndex]!.grade === 'D' ? 'bg-orange-100 text-orange-700' :
                                                'bg-red-100 text-red-700'
                                            }`}>
                                                {aiEvaluations[currentQuestionIndex]!.grade}
                                            </span>
                                        </div>
                                        <p className="text-slate-600 dark:text-slate-300 text-xs leading-snug">
                                            {aiEvaluations[currentQuestionIndex]!.feedback}
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* User Self Grading Section */}
                            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">AI 평가를 참고하여 최종 점수를 선택해주세요.</p>
                            <div className="grid grid-cols-5 gap-1">
                                <button 
                                    onClick={() => handleGradeSelection('A')}
                                    className={`py-2 px-1 rounded border text-[10px] sm:text-xs font-medium transition-all ${
                                        shortAnswerGrades[currentQuestionIndex] === 'A' 
                                        ? 'bg-green-100 border-green-500 text-green-700 ring-1 ring-green-500 dark:bg-green-900/30 dark:text-green-300' 
                                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50 dark:bg-slate-700 dark:border-slate-600 dark:text-slate-300'
                                    }`}
                                >
                                    A (100%)
                                </button>
                                <button 
                                    onClick={() => handleGradeSelection('B')}
                                    className={`py-2 px-1 rounded border text-[10px] sm:text-xs font-medium transition-all ${
                                        shortAnswerGrades[currentQuestionIndex] === 'B' 
                                        ? 'bg-blue-100 border-blue-500 text-blue-700 ring-1 ring-blue-500 dark:bg-blue-900/30 dark:text-blue-300' 
                                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50 dark:bg-slate-700 dark:border-slate-600 dark:text-slate-300'
                                    }`}
                                >
                                    B (75%)
                                </button>
                                <button 
                                    onClick={() => handleGradeSelection('C')}
                                    className={`py-2 px-1 rounded border text-[10px] sm:text-xs font-medium transition-all ${
                                        shortAnswerGrades[currentQuestionIndex] === 'C' 
                                        ? 'bg-yellow-100 border-yellow-500 text-yellow-700 ring-1 ring-yellow-500 dark:bg-yellow-900/30 dark:text-yellow-300' 
                                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50 dark:bg-slate-700 dark:border-slate-600 dark:text-slate-300'
                                    }`}
                                >
                                    C (50%)
                                </button>
                                <button 
                                    onClick={() => handleGradeSelection('D')}
                                    className={`py-2 px-1 rounded border text-[10px] sm:text-xs font-medium transition-all ${
                                        shortAnswerGrades[currentQuestionIndex] === 'D' 
                                        ? 'bg-orange-100 border-orange-500 text-orange-700 ring-1 ring-orange-500 dark:bg-orange-900/30 dark:text-orange-300' 
                                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50 dark:bg-slate-700 dark:border-slate-600 dark:text-slate-300'
                                    }`}
                                >
                                    D (25%)
                                </button>
                                <button 
                                    onClick={() => handleGradeSelection('E')}
                                    className={`py-2 px-1 rounded border text-[10px] sm:text-xs font-medium transition-all ${
                                        shortAnswerGrades[currentQuestionIndex] === 'E' 
                                        ? 'bg-red-100 border-red-500 text-red-700 ring-1 ring-red-500 dark:bg-red-900/30 dark:text-red-300' 
                                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50 dark:bg-slate-700 dark:border-slate-600 dark:text-slate-300'
                                    }`}
                                >
                                    E (0%)
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="max-w-3xl mx-auto pb-24 md:pb-20">
             {/* Header: Progress & Question Type */}
             <div className="mb-4 sm:mb-6">
                <div className="flex justify-between items-end mb-2">
                    <span className="text-sm font-bold text-neon-blue">
                        문제 {currentQuestionIndex + 1}
                        <span className="text-slate-400 font-normal"> / {safeQuestions.length}</span>
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded">
                        {currentQuestion.questionType === 'multiple-choice' ? '객관식' : 
                         currentQuestion.questionType === 'ox' ? 'OX 퀴즈' :
                         currentQuestion.questionType === 'short-answer' ? '단답형' : '창의 서술형'}
                    </span>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                    <div 
                        className="bg-neon-blue h-2 rounded-full transition-all duration-300 ease-out"
                        style={{ width: `${((currentQuestionIndex + 1) / safeQuestions.length) * 100}%` }}
                    ></div>
                </div>
            </div>

            <Card className="p-4 sm:p-6 md:p-8 min-h-[300px] flex flex-col relative">
                {/* Question Text */}
                <div className="mb-6">
                    <div className="flex justify-between items-start gap-4 mb-4">
                        <div className="prose prose-lg dark:prose-invert max-w-none text-slate-900 dark:text-slate-100 leading-relaxed font-medium">
                            <ReactMarkdown 
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                components={markdownComponents}
                            >
                                {preprocessLaTeX(currentQuestion.question)}
                            </ReactMarkdown>
                        </div>
                        <button 
                            onClick={() => handlePlayScript(currentQuestion.question)}
                            disabled={isSpeaking || isLoadingTTS}
                            className="shrink-0 p-2 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                            aria-label="질문 듣기"
                        >
                            {isSpeaking || isLoadingTTS ? <Spinner size="sm"/> : <SpeakerIcon />}
                        </button>
                    </div>
                    
                    {showTranslation && currentQuestion.questionTranslation && (
                        <div className="bg-slate-50 dark:bg-slate-700/50 p-3 rounded-lg border border-slate-100 dark:border-slate-700 mb-4 text-sm text-slate-600 dark:text-slate-300">
                             <ReactMarkdown 
                                remarkPlugins={[remarkGfm, remarkMath]}
                                rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                components={markdownComponents}
                            >
                                {preprocessLaTeX(currentQuestion.questionTranslation)}
                            </ReactMarkdown>
                        </div>
                    )}

                    {/* Image if available */}
                    {currentQuestion.imageBase64 && (
                        <div className="mb-6 flex justify-center">
                            <img 
                                src={`data:image/png;base64,${currentQuestion.imageBase64}`} 
                                alt="문제 이미지" 
                                className="max-w-full h-auto max-h-64 rounded-lg shadow-md border border-slate-200 dark:border-slate-700"
                            />
                        </div>
                    )}

                    {/* Passage / Script if available */}
                    {currentQuestion.passage && (
                        <div className="mb-6 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                             <div className="flex justify-between items-center mb-2">
                                <span className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                    <ScriptIcon className="w-3 h-3" /> 지문 / 스크립트
                                </span>
                                <button
                                    onClick={() => handlePlayScript(currentQuestion.passage!)}
                                    disabled={isSpeaking || isLoadingTTS}
                                    className="text-xs flex items-center gap-1 text-slate-500 hover:text-neon-blue transition-colors"
                                >
                                    <SpeakerIcon className="w-3 h-3" /> 듣기
                                </button>
                             </div>
                             <div className="prose prose-sm dark:prose-invert max-w-none text-slate-700 dark:text-slate-300">
                                <ReactMarkdown 
                                    remarkPlugins={[remarkGfm, remarkMath]}
                                    rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                    components={markdownComponents}
                                >
                                    {preprocessLaTeX(currentQuestion.passage)}
                                </ReactMarkdown>
                             </div>
                             {showTranslation && currentQuestion.passageTranslation && (
                                <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700 prose prose-sm dark:prose-invert max-w-none text-slate-600 dark:text-slate-400">
                                    <ReactMarkdown 
                                        remarkPlugins={[remarkGfm, remarkMath]}
                                        rehypePlugins={[[rehypeKatex, { output: 'html' }]]} 
                                        components={markdownComponents}
                                    >
                                        {preprocessLaTeX(currentQuestion.passageTranslation)}
                                    </ReactMarkdown>
                                </div>
                             )}
                        </div>
                    )}
                </div>

                {/* Render Options or Input */}
                {renderQuestionInput()}
            </Card>

            {/* Footer Actions */}
            <div className="fixed bottom-0 left-0 right-0 p-3 sm:p-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border-t border-slate-200 dark:border-slate-700 z-40 md:static md:bg-transparent md:border-0 md:p-0 md:mt-6">
                <div className="max-w-3xl mx-auto flex gap-3 items-center">
                    {/* Translation Toggle (if applicable) */}
                    {(currentQuestion.questionTranslation || currentQuestion.passageTranslation) && (
                        <button
                            onClick={() => setShowTranslation(!showTranslation)}
                            className={`p-3 rounded-lg border transition-colors ${showTranslation ? 'bg-yellow-50 border-yellow-200 text-yellow-700 dark:bg-yellow-900/30 dark:border-yellow-700 dark:text-yellow-400' : 'bg-white border-slate-300 text-slate-500 hover:bg-slate-50 dark:bg-slate-800 dark:border-slate-600 dark:text-slate-400'}`}
                            title="한글 번역 보기"
                        >
                            <TranslateIcon />
                        </button>
                    )}

                    <div className="flex-1 flex gap-3">
                        {!isAnswerChecked ? (
                            <Button 
                                onClick={handleCheckAnswer} 
                                disabled={
                                    (currentQuestion.questionType === 'multiple-choice' || currentQuestion.questionType === 'ox') 
                                    ? !userAnswer 
                                    : !tempShortAnswer.trim()
                                }
                                className="w-full py-3 text-lg shadow-lg md:shadow-none"
                            >
                                정답 확인
                            </Button>
                        ) : (
                            <Button 
                                onClick={handleNext} 
                                className="w-full py-3 text-lg shadow-lg md:shadow-none"
                            >
                                {isLastQuestion ? '결과 보기' : '다음 문제'}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
