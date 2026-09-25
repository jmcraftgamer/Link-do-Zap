// ============================================
// Providers Data - Real AI Models
// ============================================

const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v3.005l-2.607 1.5-2.602-1.5z"/></svg>`,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', free: false },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', free: false },
      { id: 'gpt-4o-2024-08-06', name: 'GPT-4o 2024-08-06', free: false },
      { id: 'gpt-4.1', name: 'GPT-4.1', free: false },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', free: false },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', free: false },
      { id: 'gpt-5', name: 'GPT-5', free: false },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', free: false },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano', free: false },
      { id: 'gpt-5-pro', name: 'GPT-5 Pro', free: false },
      { id: 'gpt-5.4', name: 'GPT-5.4', free: false },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', free: false },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', free: false },
      { id: 'gpt-5.4-pro', name: 'GPT-5.4 Pro', free: false },
      { id: 'gpt-5.5', name: 'GPT-5.5', free: false },
      { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', free: false },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', free: false },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', free: false },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', free: false },
      { id: 'o1', name: 'o1', free: false },
      { id: 'o1-mini', name: 'o1 Mini', free: false },
      { id: 'o1-pro', name: 'o1 Pro', free: false },
      { id: 'o3', name: 'o3', free: false },
      { id: 'o3-mini', name: 'o3 Mini', free: false },
      { id: 'o3-pro', name: 'o3 Pro', free: false },
      { id: 'o4-mini', name: 'o4 Mini', free: false },
      { id: 'dall-e-2', name: 'DALL-E 2', free: false },
      { id: 'dall-e-3', name: 'DALL-E 3', free: false },
      { id: 'tts-1', name: 'TTS-1', free: false },
      { id: 'tts-1-hd', name: 'TTS-1 HD', free: false },
      { id: 'whisper-1', name: 'Whisper-1', free: false },
      { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe', free: false },
      { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe', free: false },
      { id: 'text-embedding-3-small', name: 'Embedding 3 Small', free: false },
      { id: 'text-embedding-3-large', name: 'Embedding 3 Large', free: false },
      { id: 'text-embedding-ada-002', name: 'Embedding Ada-002', free: false }
    ]
  },
  {
    id: 'google',
    name: 'Google Studio',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#111" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#111" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#111" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`,
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', free: true },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', free: true },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', free: true },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', free: true },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', free: true },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', free: true },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', free: true },
      { id: 'gemini-1.5-flash-8b', name: 'Gemini 1.5 Flash 8B', free: true },
      { id: 'gemini-pro', name: 'Gemini Pro', free: true },
      { id: 'imagen-3.0-generate-002', name: 'Imagen 3', free: true },
      { id: 'text-embedding-004', name: 'Embedding 004', free: true },
      { id: 'embedding-001', name: 'Embedding 001', free: true }
    ]
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.742 20.48h-3.674l-1.632-4.317h-6.46l-1.59 4.317H0L6.57 3.52zm1.04 5.412l-2.196 5.76h4.347l-2.15-5.76z"/></svg>`,
    models: [
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', free: false },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', free: false },
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', free: false },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet v2', free: false },
      { id: 'claude-3-5-sonnet-20240620', name: 'Claude 3.5 Sonnet', free: false },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', free: false },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', free: false },
      { id: 'claude-3-sonnet-20240229', name: 'Claude 3 Sonnet', free: false },
      { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', free: false }
    ]
  },
  {
    id: 'groq',
    name: 'Groq',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M3.89 15.672L1.454 8.92a1.055 1.055 0 0 1 .397-1.14L5.42 5.32l-2.2-3.812a1.055 1.055 0 0 1 .38-1.453l2.784-1.632a1.055 1.055 0 0 1 1.453.38L8.6 2.468l3.434-1.987a1.055 1.055 0 0 1 1.453.38l1.055 1.828a1.055 1.055 0 0 1-.38 1.453l-2.11 1.22 3.812 2.2a1.055 1.055 0 0 1 .38 1.453L13.12 13.3a1.055 1.055 0 0 1-1.453.38l-3.812-2.2-2.96 1.712a1.055 1.055 0 0 1-1.453-.38l-1.055-1.828a1.055 1.055 0 0 1 .38-1.453l2.11-1.22-.692-2.012 1.712 4.982z"/></svg>`,
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', free: true },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', free: true },
      { id: 'llama-3.2-1b-preview', name: 'Llama 3.2 1B Preview', free: true },
      { id: 'llama-3.2-3b-preview', name: 'Llama 3.2 3B Preview', free: true },
      { id: 'llama-3.2-11b-vision-preview', name: 'Llama 3.2 11B Vision', free: true },
      { id: 'llama-3.2-90b-vision-preview', name: 'Llama 3.2 90B Vision', free: true },
      { id: 'llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B', free: true },
      { id: 'llama-4-scout-instruct', name: 'Llama 4 Scout', free: true },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B', free: true },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', free: true },
      { id: 'whisper-large-v3', name: 'Whisper Large V3', free: true },
      { id: 'whisper-large-v3-turbo', name: 'Whisper Large V3 Turbo', free: true },
      { id: 'qwen3-32b', name: 'Qwen3 32B', free: true },
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', free: true },
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', free: true }
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
    models: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B', free: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B', free: true },
      { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning', free: true },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano Omni 30B', free: true },
      { id: 'nvidia/nemotron-3.5-content-safety:free', name: 'Nemotron 3.5 Content Safety', free: true },
      { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B', free: true },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', free: true },
      { id: 'cohere/north-mini-code:free', name: 'Cohere North Mini Code', free: true },
      { id: 'poolside/laguna-s-2.1:free', name: 'Poolside Laguna S 2.1', free: true },
      { id: 'poolside/laguna-xs-2.1:free', name: 'Poolside Laguna XS 2.1', free: true },
      { id: 'inclusionai/ling-3.0-flash-fin:free', name: 'Ling 3.0 Flash Fin', free: true },
      { id: 'inclusionai/ling-3.0-flash-sante:free', name: 'Ling 3.0 Flash Sante', free: true },
      { id: 'thinkingmachines/inkling:free', name: 'Inkling', free: true },
      { id: 'thinkingmachines/inkling-small:free', name: 'Inkling Small', free: true },
      { id: 'dots-studio/dots-3-note-preview:free', name: 'Dots 3 Note Preview', free: true },
      { id: 'nex-agi/nex-n2.5-mini:free', name: 'NEX N2.5 Mini', free: true },
      { id: 'nex-agi/nex-n2.5-pro:free', name: 'NEX N2.5 Pro', free: true },
      { id: 'liquid/lfm-2.5-2.6b:free', name: 'LFM 2.5 2.6B', free: true },
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', free: false },
      { id: 'mistralai/mistral-large', name: 'Mistral Large', free: false },
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', free: false },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', free: false },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', free: false },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', free: false },
      { id: 'openai/gpt-4o', name: 'GPT-4o', free: false },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', free: false },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', free: false },
      { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', free: false }
    ]
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12.527 2.027c-.052 0-.104.004-.156.004v2.976c.052-.004.104-.008.156-.008 3.816 0 6.913 3.096 6.913 6.914 0 3.816-3.097 6.912-6.913 6.912-.052 0-.104-.004-.156-.008v2.976c.052.004.104.008.156.008 5.474 0 9.916-4.442 9.916-9.912C22.443 6.477 18.001 2.027 12.527 2.027zM8.436 3.958l-2.94 1.677 1.324 2.34 2.724-1.555v8.06l-3.168 1.808L2.414 14.65l1.32-2.336 2.728 1.559V6.881l-1.556-.889L8.436 3.958z"/></svg>`,
    models: [
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', free: true },
      { id: 'nvidia/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', free: true },
      { id: 'nvidia/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'nvidia/mistral-nemo-12b-instruct', name: 'Mistral Nemo 12B', free: true },
      { id: 'nvidia/nemotron-mini-4b-instruct', name: 'Nemotron Mini 4B', free: true },
      { id: 'nvidia/gemma-2-9b-it', name: 'Gemma 2 9B', free: true },
      { id: 'nvidia/starcoder2-15b', name: 'StarCoder2 15B', free: true }
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.5 14.5h-9v-1h9v1zm0-3h-9v-1h9v1zm0-3h-9v-1h9v1z"/></svg>`,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', free: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', free: true }
    ]
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M2.253 7.13h2.196L7.47 14.8l3.03-7.67h2.355L7.2 20.87 2.253 7.13zm16.344.255l-4.09 9.48h-.24L12.7 7.385h-2.34l4.89 11.37h.24l4.02-9.48h.087z"/></svg>`,
    models: [
      { id: 'grok-2', name: 'Grok-2', free: false },
      { id: 'grok-2-mini', name: 'Grok-2 Mini', free: false },
      { id: 'grok-3', name: 'Grok-3', free: false },
      { id: 'grok-3-mini', name: 'Grok-3 Mini', free: false },
      { id: 'grok-3-fast', name: 'Grok-3 Fast', free: false }
    ]
  },
  {
    id: 'meta',
    name: 'Meta (Llama)',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2.04c-5.5 0-10 4.49-10 10.02 0 5 3.66 9.15 8.44 9.9v-7H7.9v-2.9h2.54V9.85c0-2.52 1.49-3.93 3.78-3.93 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.45 2.9h-2.33v7a10 10 0 0 0 8.44-9.9c0-5.53-4.5-10.02-10-10.02z"/></svg>`,
    models: [
      { id: 'llama-3.1-405b', name: 'Llama 3.1 405B', free: false },
      { id: 'llama-3.1-70b', name: 'Llama 3.1 70B', free: false },
      { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', free: false },
      { id: 'llama-3.2-1b', name: 'Llama 3.2 1B', free: false },
      { id: 'llama-3.2-3b', name: 'Llama 3.2 3B', free: false },
      { id: 'llama-3.2-11b-vision', name: 'Llama 3.2 11B Vision', free: false },
      { id: 'llama-3.2-90b-vision', name: 'Llama 3.2 90B Vision', free: false },
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', free: false },
      { id: 'llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', free: false },
      { id: 'llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B', free: false }
    ]
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M3.44 7.76h3.4l3.46 9.68h-3.4L3.44 7.76zm10.18 0h3.4l3.46 9.68h-3.4l-3.46-9.68z"/></svg>`,
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', free: false },
      { id: 'mistral-medium-latest', name: 'Mistral Medium', free: false },
      { id: 'mistral-small-latest', name: 'Mistral Small', free: false },
      { id: 'open-mixtral-8x22b', name: 'Mixtral 8x22B', free: false },
      { id: 'open-mixtral-8x7b', name: 'Mixtral 8x7B', free: false },
      { id: 'open-mistral-7b', name: 'Mistral 7B', free: false },
      { id: 'codestral-latest', name: 'Codestral', free: false },
      { id: 'open-mistral-nemo', name: 'Mistral Nemo', free: false },
      { id: 'pixtral-large-latest', name: 'Pixtral Large', free: false },
      { id: 'mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B', free: false }
    ]
  },
  {
    id: 'cohere',
    name: 'Cohere',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M18.9 14.18c-.12.53-.56.82-1.08.82h-3.52c-.52 0-.96-.29-1.08-.82L12 9.5l-1.22 4.68c-.12.53-.56.82-1.08.82H6.18c-.52 0-.96-.29-1.08-.82L2.74 8.14c-.12-.53.16-1.08.69-1.2l1.74-.39c.53-.12 1.08.16 1.2.69l.84 3.75h8.42l.84-3.75c.12-.53.67-.81 1.2-.69l1.74.39c.53.12.81.67.69 1.2l-2.16 5.66z"/></svg>`,
    models: [
      { id: 'command-r-plus', name: 'Command R+', free: false },
      { id: 'command-r', name: 'Command R', free: false },
      { id: 'command-light', name: 'Command Light', free: false },
      { id: 'embed-english-v3.0', name: 'Embed English v3', free: false },
      { id: 'embed-multilingual-v3.0', name: 'Embed Multilingual v3', free: false }
    ]
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="#111"/></svg>`,
    models: [
      { id: 'llama-3.1-sonar-large-128k-online', name: 'Sonar Large 128K', free: false },
      { id: 'llama-3.1-sonar-small-128k-online', name: 'Sonar Small 128K', free: false },
      { id: 'llama-3.1-sonar-huge-128k-online', name: 'Sonar Huge 128K', free: false },
      { id: 'llama-3.1-sonar-medium-128k-online', name: 'Sonar Medium 128K', free: false }
    ]
  },
  {
    id: 'together',
    name: 'Together AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18L19.35 8 12 11.82 4.65 8 12 4.18zM4 9.64l7 3.5V19.5l-7-3.5V9.64zm9 10.36v-6.36l7-3.5v6.36l-7 3.5z"/></svg>`,
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', name: 'Llama 3.1 405B Turbo', free: false },
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', name: 'Llama 3.1 70B Turbo', free: false },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', name: 'Llama 3.1 8B Turbo', free: false },
      { id: 'mistralai/Mixtral-8x22B-Instruct-v0.1', name: 'Mixtral 8x22B', free: false },
      { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B', free: false },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', name: 'Qwen 2.5 72B Turbo', free: false },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', name: 'Qwen 2.5 Coder 32B', free: false },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', free: false }
    ]
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
    models: [
      { id: 'accounts/fireworks/models/llama-v3p1-405b-instruct', name: 'Llama 3.1 405B', free: false },
      { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct', name: 'Llama 3.1 70B', free: false },
      { id: 'accounts/fireworks/models/llama-v3p1-8b-instruct', name: 'Llama 3.1 8B', free: false },
      { id: 'accounts/fireworks/models/mixtral-8x22b-instruct', name: 'Mixtral 8x22B', free: false },
      { id: 'accounts/fireworks/models/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', free: false },
      { id: 'accounts/fireworks/models/deepseek-v3', name: 'DeepSeek V3', free: false }
    ]
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><path d="M8 12a4 4 0 1 1 8 0 4 4 0 0 1-8 0z" fill="#111"/></svg>`,
    models: [
      { id: 'llama3.1', name: 'Llama 3.1', free: true },
      { id: 'llama3.2', name: 'Llama 3.2', free: true },
      { id: 'llama3.3', name: 'Llama 3.3', free: true },
      { id: 'llama4-scout', name: 'Llama 4 Scout', free: true },
      { id: 'llama4-maverick', name: 'Llama 4 Maverick', free: true },
      { id: 'mistral', name: 'Mistral', free: true },
      { id: 'mixtral', name: 'Mixtral', free: true },
      { id: 'phi3', name: 'Phi-3', free: true },
      { id: 'phi4', name: 'Phi-4', free: true },
      { id: 'gemma2', name: 'Gemma 2', free: true },
      { id: 'gemma3', name: 'Gemma 3', free: true },
      { id: 'qwen2.5', name: 'Qwen 2.5', free: true },
      { id: 'deepseek-r1', name: 'DeepSeek R1', free: true },
      { id: 'deepseek-v3', name: 'DeepSeek V3', free: true },
      { id: 'codellama', name: 'Code Llama', free: true },
      { id: 'codegemma', name: 'CodeGemma', free: true },
      { id: 'codestral', name: 'Codestral', free: true },
      { id: 'command-r', name: 'Command R', free: true },
      { id: 'vicuna', name: 'Vicuna', free: true },
      { id: 'orca-mini', name: 'Orca Mini', free: true },
      { id: 'solar', name: 'Solar', free: true },
      { id: 'tinyllama', name: 'TinyLlama', free: true }
    ]
  },
  {
    id: 'huggingface',
    name: 'HuggingFace',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm-5 9.5a3 3 0 0 0-3 3v1a3 3 0 0 0 6 0v-1a3 3 0 0 0-3-3zm10 0a3 3 0 0 0-3 3v1a3 3 0 0 0 6 0v-1a3 3 0 0 0-3-3zm-5 5.5a3 3 0 0 0-3 3v1a3 3 0 0 0 6 0v-1a3 3 0 0 0-3-3z"/></svg>`,
    models: [
      { id: 'meta-llama/Llama-3.1-405B-Instruct', name: 'Llama 3.1 405B', free: true },
      { id: 'meta-llama/Llama-3.1-70B-Instruct', name: 'Llama 3.1 70B', free: true },
      { id: 'meta-llama/Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', free: true },
      { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B v0.3', free: true },
      { id: 'google/gemma-2-27b-it', name: 'Gemma 2 27B', free: true },
      { id: 'microsoft/Phi-3-medium-4k-instruct', name: 'Phi-3 Medium', free: true },
      { id: 'HuggingFaceH4/zephyr-7b-beta', name: 'Zephyr 7B', free: true },
      { id: 'databricks/dbrx-instruct', name: 'DBRX Instruct', free: true }
    ]
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M11.4 2L2 6.3v11.4l9.4 4.3L21 17.7V6.3L11.4 2zm0 2.1L18.5 7v10L11.4 19.9 4 16.6V7l7.4-2.9z"/></svg>`,
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', free: false },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', free: false },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', free: false },
      { id: 'gpt-4', name: 'GPT-4', free: false },
      { id: 'gpt-35-turbo', name: 'GPT-3.5 Turbo', free: false },
      { id: 'o1', name: 'o1', free: false },
      { id: 'o1-mini', name: 'o1 Mini', free: false },
      { id: 'o3-mini', name: 'o3 Mini', free: false },
      { id: 'dall-e-3', name: 'DALL-E 3', free: false },
      { id: 'whisper', name: 'Whisper', free: false },
      { id: 'tts', name: 'TTS', free: false },
      { id: 'text-embedding-3-small', name: 'Embedding 3 Small', free: false },
      { id: 'text-embedding-3-large', name: 'Embedding 3 Large', free: false }
    ]
  },
  {
    id: 'aws',
    name: 'AWS Bedrock',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.256-.248-.687-.367-1.3-.367-.28 0-.568.031-.863.104-.296.072-.583.16-.863.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.28-.144.615-.264 1.006-.36a4.84 4.84 0 0 1 1.246-.152c.95 0 1.644.216 2.091.647.44.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296z"/></svg>`,
    models: [
      { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet v2', free: false },
      { id: 'anthropic.claude-3-5-haiku-20241022-v1:0', name: 'Claude 3.5 Haiku', free: false },
      { id: 'anthropic.claude-3-opus-20240229-v1:0', name: 'Claude 3 Opus', free: false },
      { id: 'anthropic.claude-3-sonnet-20240229-v1:0', name: 'Claude 3 Sonnet', free: false },
      { id: 'anthropic.claude-3-haiku-20240307-v1:0', name: 'Claude 3 Haiku', free: false },
      { id: 'meta.llama3-1-405b-instruct-v1:0', name: 'Llama 3.1 405B', free: false },
      { id: 'meta.llama3-1-70b-instruct-v1:0', name: 'Llama 3.1 70B', free: false },
      { id: 'meta.llama3-1-8b-instruct-v1:0', name: 'Llama 3.1 8B', free: false },
      { id: 'mistral.mixtral-8x7b-instruct-v0:1', name: 'Mixtral 8x7B', free: false },
      { id: 'cohere.command-r-plus-v1:0', name: 'Command R+', free: false },
      { id: 'cohere.command-r-v1:0', name: 'Command R', free: false },
      { id: 'ai21.jamba-1-5-large-v1:0', name: 'Jamba 1.5 Large', free: false },
      { id: 'ai21.jamba-1-5-mini-v1:0', name: 'Jamba 1.5 Mini', free: false }
    ]
  },
  {
    id: 'replicate',
    name: 'Replicate',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 3l6 3-6 3-6-3 6-3zm-8 7l8 4 8-4v2l-8 4-8-4v-2z"/></svg>`,
    models: [
      { id: 'meta/meta-llama-3.1-405b-instruct', name: 'Llama 3.1 405B', free: false },
      { id: 'meta/meta-llama-3.1-70b-instruct', name: 'Llama 3.1 70B', free: false },
      { id: 'meta/meta-llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: false },
      { id: 'mistralai/mixtral-8x7b-instruct', name: 'Mixtral 8x7B', free: false }
    ]
  },
  {
    id: 'inference',
    name: 'Microsoft Inference',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><rect x="2" y="2" width="9" height="9" fill="#111"/><rect x="13" y="2" width="9" height="9" fill="#111"/><rect x="2" y="13" width="9" height="9" fill="#111"/><rect x="13" y="13" width="9" height="9" fill="#111"/></svg>`,
    models: [
      { id: 'meta-llama-3.1-405b-instruct', name: 'Llama 3.1 405B', free: true },
      { id: 'meta-llama-3.1-70b-instruct', name: 'Llama 3.1 70B', free: true },
      { id: 'meta-llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'mistral-large', name: 'Mistral Large', free: true },
      { id: 'mistral-small', name: 'Mistral Small', free: true },
      { id: 'phi-3-medium-4k-instruct', name: 'Phi-3 Medium', free: true },
      { id: 'phi-3-mini-4k-instruct', name: 'Phi-3 Mini', free: true },
      { id: 'gemma-2-9b', name: 'Gemma 2 9B', free: true }
    ]
  },
  {
    id: 'novita',
    name: 'Novita AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><path d="M12 6v12M6 12h12" stroke="#111" stroke-width="2"/></svg>`,
    models: [
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', free: false },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', free: false },
      { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: false },
      { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', free: false },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', free: false }
    ]
  },
  {
    id: 'chutes',
    name: 'Chutes AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
    models: [
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', free: false },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', free: false },
      { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: false }
    ]
  },
  {
    id: 'lambda',
    name: 'Lambda',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M5 3v18l7-3 7 3V3H5zm7 12.5L7 17V5h10v12l-5-1.5z"/></svg>`,
    models: [
      { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', free: false },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', free: false },
      { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: false },
      { id: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1', free: false }
    ]
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="none" stroke="#111" stroke-width="2"/></svg>`,
    models: [
      { id: 'Meta-Llama-3.1-405B-Instruct', name: 'Llama 3.1 405B', free: true },
      { id: 'Meta-Llama-3.1-70B-Instruct', name: 'Llama 3.1 70B', free: true },
      { id: 'Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'DeepSeek-V3-0324', name: 'DeepSeek V3', free: true },
      { id: 'QwQ-32B', name: 'QwQ 32B', free: true }
    ]
  },
  {
    id: 'writer',
    name: 'Writer',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`,
    models: [
      { id: 'palmyra-x-004', name: 'Palmyra X 004', free: false },
      { id: 'palmyra-x-003', name: 'Palmyra X 003', free: false },
      { id: 'palmyra-x-002', name: 'Palmyra X 002', free: false }
    ]
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI (GLM)',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-size="10" fill="#111" font-weight="bold">Z</text></svg>`,
    models: [
      { id: 'glm-4-plus', name: 'GLM-4 Plus', free: false },
      { id: 'glm-4', name: 'GLM-4', free: false },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', free: true },
      { id: 'glm-4-air', name: 'GLM-4 Air', free: false },
      { id: 'glm-4-airx', name: 'GLM-4 AirX', free: false },
      { id: 'glm-4-long', name: 'GLM-4 Long', free: false },
      { id: 'glm-4-flashx', name: 'GLM-4 FlashX', free: true },
      { id: 'glm-4v-plus', name: 'GLM-4V Plus', free: false },
      { id: 'glm-4v-flash', name: 'GLM-4V Flash', free: true },
      { id: 'embedding-3', name: 'Embedding 3', free: false }
    ]
  },
  {
    id: 'baidu',
    name: 'Baidu (ERNIE)',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-size="10" fill="#111" font-weight="bold">B</text></svg>`,
    models: [
      { id: 'ernie-4.0-turbo', name: 'ERNIE 4.0 Turbo', free: false },
      { id: 'ernie-4.0', name: 'ERNIE 4.0', free: false },
      { id: 'ernie-3.5', name: 'ERNIE 3.5', free: false },
      { id: 'ernie-speed', name: 'ERNIE Speed', free: true },
      { id: 'ernie-lite', name: 'ERNIE Lite', free: true },
      { id: 'ernie-speed-128k', name: 'ERNIE Speed 128K', free: true }
    ]
  },
  {
    id: 'alibaba',
    name: 'Alibaba (Qwen)',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-size="10" fill="#111" font-weight="bold">Q</text></svg>`,
    models: [
      { id: 'qwen-max', name: 'Qwen Max', free: false },
      { id: 'qwen-plus', name: 'Qwen Plus', free: false },
      { id: 'qwen-turbo', name: 'Qwen Turbo', free: true },
      { id: 'qwen-long', name: 'Qwen Long', free: false },
      { id: 'qwen-vl-max', name: 'Qwen VL Max', free: false },
      { id: 'qwen-vl-plus', name: 'Qwen VL Plus', free: false },
      { id: 'qwen-coder-plus', name: 'Qwen Coder Plus', free: false }
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><path d="M8 12l4-4 4 4M8 16l4-4 4 4" stroke="#111" stroke-width="2" fill="none"/></svg>`,
    models: [
      { id: 'abab6.5s', name: 'ABAB 6.5S', free: false },
      { id: 'abab6.5', name: 'ABAB 6.5', free: false },
      { id: 'abab5.5', name: 'ABAB 5.5', free: false },
      { id: 'abab5.5-chat', name: 'ABAB 5.5 Chat', free: false }
    ]
  },
  {
    id: 'upstage',
    name: 'Upstage',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><path d="M12 6v12M9 9l3-3 3 3" stroke="#111" stroke-width="2" fill="none"/></svg>`,
    models: [
      { id: 'solar-1-mini', name: 'Solar 1 Mini', free: false },
      { id: 'solar-pro', name: 'Solar Pro', free: false },
      { id: 'solar-mini', name: 'Solar Mini', free: false },
      { id: 'solar-1-30b-a4b', name: 'Solar 1 30B', free: false }
    ]
  },
  {
    id: 'ai21',
    name: 'AI21 Labs',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><text x="12" y="16" text-anchor="middle" font-size="8" fill="#111" font-weight="bold">21</text></svg>`,
    models: [
      { id: 'jamba-1.5-large', name: 'Jamba 1.5 Large', free: false },
      { id: 'jamba-1.5-mini', name: 'Jamba 1.5 Mini', free: false },
      { id: 'jamba-instruct', name: 'Jamba Instruct', free: false },
      { id: 'j2-ultra', name: 'J2 Ultra', free: false },
      { id: 'j2-mid', name: 'J2 Mid', free: false },
      { id: 'j2-light', name: 'J2 Light', free: false }
    ]
  },
  {
    id: 'voyage',
    name: 'Voyage AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><path d="M12 4l2 8-8 2 8 2-2 8-2-8-8-2 8-2z" fill="#111"/></svg>`,
    models: [
      { id: 'voyage-3', name: 'Voyage 3', free: false },
      { id: 'voyage-3-lite', name: 'Voyage 3 Lite', free: false },
      { id: 'voyage-2', name: 'Voyage 2', free: false },
      { id: 'voyage-code-3', name: 'Voyage Code 3', free: false },
      { id: 'voyage-law-2', name: 'Voyage Law 2', free: false },
      { id: 'voyage-large-2', name: 'Voyage Large 2', free: false }
    ]
  },
  {
    id: 'jina',
    name: 'Jina AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><path d="M8 8h8v8H8z" fill="none" stroke="#111" stroke-width="2"/></svg>`,
    models: [
      { id: 'jina-embeddings-v3', name: 'Embeddings V3', free: true },
      { id: 'jina-embeddings-v2-base-en', name: 'Embeddings V2 Base', free: true },
      { id: 'jina-embeddings-v2-small-en', name: 'Embeddings V2 Small', free: true },
      { id: 'jina-reranker-v2-base-multilingual', name: 'Reranker V2 Base', free: true }
    ]
  },
  {
    id: 'friendli',
    name: 'Friendli AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><circle cx="9" cy="10" r="1.5" fill="#111"/><circle cx="15" cy="10" r="1.5" fill="#111"/><path d="M8 14c1.5 2 6.5 2 8 0" stroke="#111" stroke-width="1.5" fill="none"/></svg>`,
    models: [
      { id: 'meta-llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'meta-llama-3.1-70b-instruct', name: 'Llama 3.1 70B', free: false },
      { id: 'mixtral-8x7b-instruct-v0.1', name: 'Mixtral 8x7B', free: true }
    ]
  },
  {
    id: 'fireworks-free',
    name: 'Fireworks (Gratuito)',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
    models: [
      { id: 'accounts/fireworks/models/llama-v3.1-8b-instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'accounts/fireworks/models/mixtral-8x7b', name: 'Mixtral 8x7B', free: true },
      { id: 'accounts/fireworks/models/qwen-1.5-7b-chat', name: 'Qwen 1.5 7B', free: true }
    ]
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><path d="M12 6v12M6 12h12" stroke="#111" stroke-width="2"/></svg>`,
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', free: true },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', free: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', free: true },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', name: 'Qwen 2.5 Coder 32B', free: true },
      { id: 'THUDM/glm-4-9b-chat', name: 'GLM-4 9B', free: true },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B', free: true }
    ]
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><path fill="#111" d="M16.5 18h-9a.5.5 0 0 1 0-1h9a.5.5 0 0 1 0 1zm2-3H5.5a.5.5 0 0 1 0-1h13a.5.5 0 0 1 0 1zm1.5-4H4a.5.5 0 0 1 0-1h16a.5.5 0 0 1 0 1z"/></svg>`,
    models: [
      { id: '@cf/meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B', free: true },
      { id: '@cf/meta/llama-3-8b-instruct', name: 'Llama 3 8B', free: true },
      { id: '@cf/mistral/mistral-7b-instruct-v0.2', name: 'Mistral 7B', free: true },
      { id: '@cf/qwen/qwen1.5-14b-chat-awq', name: 'Qwen 1.5 14B', free: true },
      { id: '@cf/tinyllama/tinyllama-1.1b-chat-v1.0', name: 'TinyLlama 1.1B', free: true }
    ]
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    logo: `<svg viewBox="0 0 24 24" width="32" height="32"><circle cx="12" cy="12" r="10" fill="none" stroke="#111" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="#111"/></svg>`,
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-405B-Instruct', name: 'Llama 3.1 405B', free: false },
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct', name: 'Llama 3.1 70B', free: false },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B', free: true },
      { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B', free: true },
      { id: 'microsoft/Phi-3-mini-4k-instruct', name: 'Phi-3 Mini', free: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B', free: false }
    ]
  }
];
