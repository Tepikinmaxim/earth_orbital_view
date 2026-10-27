'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Sun,
  Moon,
  MoonStar,
  Clock3,
  Snowflake,
  Flower2,
  Leaf,
  Cloud,
  Lightbulb,
  Orbit,
  Sparkles,
  Settings2,
  X,
  MousePointer2,
  ZoomIn,
  RefreshCw,
  Search,
  MapPin,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import {
  createTerraScene,
  DEFAULT_SETTINGS,
  type LightingMode,
  type Season,
  type TerraController,
  type TerraSettings,
} from '@/lib/earthScene'
import {
  normalizeCityQuery,
  searchLocalCities,
  type SearchHit,
} from '@/lib/cities'

const MAX_MARKERS = 6

/* ---- подписки на Fullscreen API для useSyncExternalStore ---- */
const noopSubscribe = () => () => {}

const subscribeFullscreen = (onChange: () => void) => {
  document.addEventListener('fullscreenchange', onChange)
  return () => document.removeEventListener('fullscreenchange', onChange)
}

const getFullscreenSnapshot = () => Boolean(document.fullscreenElement)
const getFullscreenSupported = () => document.fullscreenEnabled
const getFullscreenServerSnapshot = () => false

const LIGHTING_OPTIONS: Array<{ id: LightingMode; label: string; icon: typeof Sun }> = [
  { id: 'day', label: 'День', icon: Sun },
  { id: 'night', label: 'Ночь', icon: Moon },
  { id: 'live', label: 'Сейчас', icon: Clock3 },
]

const SEASON_OPTIONS: Array<{ id: Season; label: string; icon: typeof Sun }> = [
  { id: 'winter', label: 'Зима', icon: Snowflake },
  { id: 'spring', label: 'Весна', icon: Flower2 },
  { id: 'summer', label: 'Лето', icon: Sun },
  { id: 'autumn', label: 'Осень', icon: Leaf },
]

const LAYER_OPTIONS: Array<{
  id: keyof Omit<TerraSettings, 'lighting' | 'season' | 'rotationSpeed'>
  label: string
  hint: string
  icon: typeof Sun
}> = [
  { id: 'clouds', label: 'Облака', hint: 'Дрейфующий облачный слой', icon: Cloud },
  { id: 'cityLights', label: 'Огни городов', hint: 'Ночная подсветка мегаполисов', icon: Lightbulb },
  { id: 'atmosphere', label: 'Атмосфера', hint: 'Голубое свечение по краю', icon: Orbit },
  { id: 'stars', label: 'Звёзды', hint: 'Звёздное небо с мерцанием', icon: Sparkles },
  { id: 'showSun', label: 'Показывать Солнце', hint: 'Диск и ореол светила', icon: Sun },
  { id: 'showMoon', label: 'Луна', hint: 'Спутник на наклонной орбите', icon: MoonStar },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-white/40">
      {children}
    </div>
  )
}

export default function Home() {
  const containerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<TerraController | null>(null)

  const [settings, setSettings] = useState<TerraSettings>(DEFAULT_SETTINGS)
  const [panelOpen, setPanelOpen] = useState(true)
  const [progress, setProgress] = useState(0)
  const [ready, setReady] = useState(false)
  const [faded, setFaded] = useState(false)

  /* ---- полноэкранный режим ---- */
  const isFullscreen = useSyncExternalStore(
    subscribeFullscreen,
    getFullscreenSnapshot,
    getFullscreenServerSnapshot
  )
  const fullscreenSupported = useSyncExternalStore(
    noopSubscribe,
    getFullscreenSupported,
    getFullscreenServerSnapshot
  )

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen()
      }
    } catch {
      /* браузер может запретить переход — состояние остаётся прежним */
    }
  }, [])

  /* ---- поиск городов ---- */
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [marked, setMarked] = useState<SearchHit[]>([])
  const [hint, setHint] = useState('')

  /* ---- create / dispose scene once ---- */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false

    const controller = createTerraScene(container, {
      onProgress: (loaded, total) => {
        if (!cancelled) setProgress(Math.round((loaded / Math.max(total, 1)) * 100))
      },
      onReady: () => {
        if (cancelled) return
        setProgress(100)
        // small delay so the loader does not just flash by
        window.setTimeout(() => {
          if (!cancelled) setReady(true)
        }, 450)
      },
    })
    controllerRef.current = controller
    controller.setSettings(DEFAULT_SETTINGS)
    ;(window as unknown as Record<string, unknown>).__terra = controller

    return () => {
      cancelled = true
      controller.dispose()
      controllerRef.current = null
    }
  }, [])

  /* ---- push settings into the scene ---- */
  useEffect(() => {
    controllerRef.current?.setSettings(settings)
  }, [settings])

  /* ---- loader fade-out ---- */
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(() => setFaded(true), 250)
    return () => window.clearTimeout(t)
  }, [ready])

  const patch = useCallback(
    (p: Partial<TerraSettings>) => setSettings((s) => ({ ...s, ...p })),
    []
  )

  /* ---- escape closes the panel (но не мешает вводу) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---- живой поиск: офлайн-база мгновенно + API-подсказки с задержкой ---- */
  const [apiSugg, setApiSugg] = useState<{ q: string; hits: SearchHit[] }>({ q: '', hits: [] })

  const sugg = useMemo<SearchHit[]>(() => {
    const q = query.trim()
    if (q.length < 2) return []
    const merged = searchLocalCities(q, 6)
    const api = apiSugg.q === query ? apiSugg.hits : []
    for (const r of api) {
      const dup = merged.some(
        (m) =>
          normalizeCityQuery(m.name) === normalizeCityQuery(r.name) &&
          Math.abs(m.lat - r.lat) < 0.3 &&
          Math.abs(m.lon - r.lon) < 0.3
      )
      if (!dup) merged.push(r)
    }
    return merged.slice(0, 8)
  }, [query, apiSugg])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return
    let cancelled = false
    const t = window.setTimeout(() => {
      fetch(`/api/geocode?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data: { results?: SearchHit[] }) => {
          if (cancelled || !data.results) return
          setApiSugg({ q: query, hits: data.results ?? [] })
        })
        .catch(() => {
          /* офлайн — работает локальная база */
        })
    }, 320)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [query])

  const selectCity = useCallback(
    (hit: SearchHit) => {
      const c = controllerRef.current
      if (!c) return
      const exists = marked.some((m) => m.id === hit.id)
      if (exists) {
        c.focusCity(hit.id)
      } else if (marked.length >= MAX_MARKERS) {
        setHint(`Не больше ${MAX_MARKERS} меток — снимите лишние`)
        window.setTimeout(() => setHint(''), 2400)
        return
      } else {
        c.addCityMarker(hit.id, hit.name, hit.lat, hit.lon)
        c.focusCity(hit.id)
        setMarked((prev) => [...prev, hit])
      }
      setQuery('')
      inputRef.current?.blur()
    },
    [marked]
  )

  const removeCity = useCallback((id: string) => {
    controllerRef.current?.removeCityMarker(id)
    setMarked((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const clearCities = useCallback(() => {
    controllerRef.current?.clearCityMarkers()
    setMarked([])
  }, [])

  const resetView = useCallback(() => {
    const canvas = containerRef.current?.querySelector('canvas')
    canvas?.dispatchEvent(new Event('dblclick'))
  }, [])

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-black text-white">
      {/* 3D canvas */}
      <div ref={containerRef} className="absolute inset-0" aria-label="Интерактивная 3D-планета Земля" role="application" />

      {/* cinematic vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)',
        }}
      />

      {/* header */}
      <header className="absolute left-5 top-5 z-20 select-none sm:left-7 sm:top-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-[0.28em] text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)] sm:text-2xl">
          <span aria-hidden className="text-amber-300">✳</span>
          TERRA
        </h1>
        <p className="mt-1.5 hidden text-[11px] uppercase tracking-[0.22em] text-white/45 sm:block">
          Интерактивная 3D-планета
        </p>
      </header>

      {/* fullscreen toggle */}
      {fullscreenSupported && (
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
          title={isFullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
          className="absolute right-[4.5rem] top-5 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/85 backdrop-blur-md transition-all hover:bg-white/10 hover:text-white active:scale-95 sm:right-[5rem] sm:top-6"
        >
          {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
        </button>
      )}

      {/* settings toggle */}
      <button
        type="button"
        onClick={() => setPanelOpen((o) => !o)}
        aria-expanded={panelOpen}
        aria-label={panelOpen ? 'Закрыть настройки' : 'Открыть настройки'}
        className={cn(
          'absolute right-5 top-5 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white/85 backdrop-blur-md transition-all hover:bg-white/10 hover:text-white active:scale-95 sm:right-7 sm:top-6'
        )}
      >
        {panelOpen ? <X className="h-5 w-5" /> : <Settings2 className="h-5 w-5" />}
      </button>

      {/* city search */}
      <div className="absolute left-3 right-[4.6rem] top-[4.4rem] z-40 sm:left-1/2 sm:right-auto sm:top-6 sm:w-[380px] sm:-translate-x-1/2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && sugg.length > 0) selectCity(sugg[0])
              if (e.key === 'Escape') {
                setQuery('')
                inputRef.current?.blur()
              }
            }}
            placeholder="Найти город — Москва, Париж…"
            aria-label="Поиск города на глобусе"
            autoComplete="off"
            className="w-full rounded-2xl border border-white/10 bg-black/55 py-2.5 pl-10 pr-9 text-[13px] text-white outline-none backdrop-blur-2xl transition-all placeholder:text-white/30 focus:border-amber-300/40 focus:bg-black/70 focus:shadow-[0_0_0_1px_rgba(252,211,77,0.22),0_10px_40px_rgba(0,0,0,0.55)]"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              aria-label="Очистить поиск"
              className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}

          {/* подсказки */}
          {query.trim().length >= 2 && sugg.length > 0 && (
            <div
              role="listbox"
              aria-label="Подсказки городов"
              className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-white/10 bg-black/75 shadow-[0_20px_60px_rgba(0,0,0,0.7)] backdrop-blur-2xl"
            >
              {sugg.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  role="option"
                  aria-selected={i === 0}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectCity(s)
                  }}
                  className="flex w-full items-baseline gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-white/10"
                >
                  <MapPin className="h-3.5 w-3.5 shrink-0 self-center text-red-400/80" />
                  <span className="shrink-0 text-[13px] font-medium text-white/90">{s.name}</span>
                  <span className="truncate text-[11px] text-white/40">{s.country}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {hint && <p className="mt-1.5 px-1 text-[11px] text-amber-200/80">{hint}</p>}

        {/* отмеченные города */}
        {marked.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {marked.map((m) => (
              <span
                key={m.id}
                className="flex items-center gap-1 rounded-full border border-white/10 bg-black/55 py-1 pl-2.5 pr-1.5 text-[11px] font-medium text-white/85 backdrop-blur-xl"
              >
                <button
                  type="button"
                  onClick={() => controllerRef.current?.focusCity(m.id)}
                  className="transition-colors hover:text-red-400"
                  title="Показать город"
                >
                  {m.name}
                </button>
                <button
                  type="button"
                  onClick={() => removeCity(m.id)}
                  aria-label={`Убрать ${m.name}`}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/15 hover:text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {marked.length > 1 && (
              <button
                type="button"
                onClick={clearCities}
                className="rounded-full px-2 py-1 text-[11px] text-white/40 transition-colors hover:text-white/80"
              >
                Очистить
              </button>
            )}
          </div>
        )}
      </div>

      {/* control panel */}
      <aside
        aria-label="Панель управления планетой"
        className={cn(
          'absolute z-30 transition-all duration-300 ease-out',
          'inset-x-3 bottom-3 max-h-[68dvh] overflow-y-auto rounded-2xl',
          'md:inset-auto md:bottom-auto md:right-6 md:top-20 md:max-h-none md:w-[304px]',
          'border border-white/10 bg-black/60 p-5 shadow-[0_24px_70px_rgba(0,0,0,0.65)] backdrop-blur-2xl',
          panelOpen
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-4 opacity-0 md:translate-y-0 md:translate-x-4'
        )}
      >
        <div className="mb-5 flex items-center justify-between md:hidden">
          <span className="text-sm font-medium tracking-wide">Настройки</span>
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            aria-label="Закрыть настройки"
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* lighting mode */}
        <section className="mb-5">
          <SectionLabel>Освещение</SectionLabel>
          <div
            role="radiogroup"
            aria-label="Режим освещения"
            className="grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1"
          >
            {LIGHTING_OPTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={settings.lighting === id}
                onClick={() => patch({ lighting: id })}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-all',
                  settings.lighting === id
                    ? 'bg-amber-400 text-black shadow-[0_0_18px_rgba(251,191,36,0.35)]'
                    : 'text-white/65 hover:bg-white/10 hover:text-white'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          {settings.lighting === 'live' && (
            <p className="mt-2 text-[11px] leading-snug text-amber-200/60">
              Терминатор синхронизирован с реальным UTC-временем
            </p>
          )}
        </section>

        {/* season */}
        <section className="mb-5">
          <SectionLabel>Сезон</SectionLabel>
          <div
            role="radiogroup"
            aria-label="Сезон года"
            className="grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1"
          >
            {SEASON_OPTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={settings.season === id}
                onClick={() => patch({ season: id })}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] font-medium transition-all',
                  settings.season === id
                    ? 'bg-white text-black shadow-[0_0_18px_rgba(255,255,255,0.25)]'
                    : 'text-white/65 hover:bg-white/10 hover:text-white'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </section>

        {/* layers */}
        <section className="mb-5">
          <SectionLabel>Слои</SectionLabel>
          <div className="space-y-1">
            {LAYER_OPTIONS.map(({ id, label, hint, icon: Icon }) => (
              <label
                key={id}
                className="group flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-white/[0.06]"
              >
                <Checkbox
                  checked={settings[id]}
                  onCheckedChange={(v) => patch({ [id]: v === true } as Partial<TerraSettings>)}
                  aria-label={label}
                  className="border-white/30 data-[state=checked]:border-amber-400 data-[state=checked]:bg-amber-400 data-[state=checked]:text-black"
                />
                <Icon className="h-4 w-4 shrink-0 text-white/50 group-hover:text-white/75" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-tight text-white/90">
                    {label}
                  </span>
                  <span className="block truncate text-[11px] leading-tight text-white/35">
                    {hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* rotation speed */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <SectionLabel>Вращение Земли</SectionLabel>
            <span className="mb-2 rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[11px] text-amber-200/90">
              {settings.rotationSpeed.toFixed(1)}×
            </span>
          </div>
          <Slider
            aria-label="Скорость вращения Земли"
            value={[settings.rotationSpeed]}
            min={0}
            max={3}
            step={0.1}
            onValueChange={([v]) => patch({ rotationSpeed: v })}
            className="cursor-pointer [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:border-amber-400"
          />
          <div className="mt-1.5 flex justify-between text-[10px] text-white/30">
            <span>Стоп</span>
            <span>Реальное время</span>
            <span>3×</span>
          </div>
        </section>

        <button
          type="button"
          onClick={resetView}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5 text-xs font-medium text-white/75 transition-all hover:bg-white/10 hover:text-white active:scale-[0.98]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Сбросить камеру
        </button>
      </aside>

      {/* bottom hint */}
      <footer className="pointer-events-none absolute bottom-4 left-1/2 z-20 hidden -translate-x-1/2 select-none items-center gap-5 text-[11px] text-white/40 sm:flex">
        <span className="flex items-center gap-1.5">
          <MousePointer2 className="h-3 w-3" /> Тяните — вращение
        </span>
        <span aria-hidden className="text-white/20">·</span>
        <span className="flex items-center gap-1.5">
          <ZoomIn className="h-3 w-3" /> Колесо — зум
        </span>
        <span aria-hidden className="text-white/20">·</span>
        <span className="flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Двойной клик — сброс
        </span>
      </footer>

      {/* tech badge */}
      <div className="pointer-events-none absolute bottom-4 right-6 z-20 hidden select-none text-[10px] uppercase tracking-[0.2em] text-white/25 md:block">
        three.js · WebGL
      </div>

      {/* loading overlay */}
      <div
        aria-hidden={faded}
        className={cn(
          'absolute inset-0 z-50 flex flex-col items-center justify-center bg-black transition-opacity duration-700',
          faded ? 'pointer-events-none opacity-0' : 'opacity-100'
        )}
      >
        <div className="mb-6 text-3xl font-semibold tracking-[0.35em] text-white/90">
          <span className="text-amber-300">✳</span> TERRA
        </div>
        <div className="h-px w-44 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-gradient-to-r from-amber-300 to-amber-100 transition-all duration-500"
            style={{ width: `${Math.max(progress, 8)}%` }}
          />
        </div>
        <p className="mt-4 text-xs tracking-[0.25em] text-white/40">
          {progress < 100 ? `ЗАГРУЗКА ПЛАНЕТЫ · ${progress}%` : 'ГОТОВО'}
        </p>
      </div>
    </main>
  )
}
