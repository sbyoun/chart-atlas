import { useEffect, useMemo, useRef, useState } from 'react'
import './PlaylistStudio.css'
import { formatCount, pick, type Locale } from './i18n'

type PlaylistSummary = {
  id: string
  name: string
  description: string
  tracksTotal: number
  imageUrl: string | null
  openUrl: string
  embedUrl: string
}

type ChatSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  at?: string
}

type CreateChatSessionResponse = {
  session?: ChatSession
  currentSessionId?: string
  sessions?: ChatSession[]
}

type ChatSessionResetResponse = {
  enabled?: boolean
  repoUrl?: string
  currentSessionId?: string
  sessions?: ChatSession[]
}

type MobilePanel = 'chat' | 'list' | 'viewer'

type PlaylistStudioProps = {
  locale: Locale
}

const APP_BASE_URL =
  import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '')

function apiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${APP_BASE_URL}${normalizedPath}`
}

function formatSessionMeta(session: ChatSession, locale: Locale) {
  const date = session.updatedAt || session.createdAt
  if (!date) return pick(locale, 'No conversation', '대화 없음')

  return new Date(date).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function requestChatSession(reset = true) {
  const response = await fetch(apiUrl('/api/playlist-studio/chat/sessions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reset }),
  })
  const payload: unknown = await response.json()

  if (!response.ok || !payload || typeof payload !== 'object') {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error)
        : 'Failed to create a session.'
    throw new Error(error)
  }

  return payload as CreateChatSessionResponse
}

async function requestChatSessionReset() {
  const response = await fetch(apiUrl('/api/playlist-studio/chat/sessions/reset'), {
    method: 'POST',
  })
  const payload: unknown = await response.json()

  if (!response.ok || !payload || typeof payload !== 'object') {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error)
        : 'Failed to reset chat sessions.'
    throw new Error(error)
  }

  return payload as ChatSessionResetResponse
}

async function requestChatHistory(sessionId: string) {
  const response = await fetch(
    apiUrl(`/api/playlist-studio/chat/history?sessionId=${encodeURIComponent(sessionId)}`),
  )
  const payload: unknown = await response.json()

  if (!response.ok || !payload || typeof payload !== 'object') {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error?: unknown }).error)
        : 'Failed to load chat history.'
    throw new Error(error)
  }

  return (payload as { history?: ChatMessage[] }).history || []
}

function PlaylistStudio({ locale }: PlaylistStudioProps) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [playlistsLoading, setPlaylistsLoading] = useState(true)
  const [playlistError, setPlaylistError] = useState('')
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatConfigError, setChatConfigError] = useState('')
  const [repoUrl, setRepoUrl] = useState('https://github.com/sbyoun/spotify-mcp-server')
  const [activePanel, setActivePanel] = useState<MobilePanel>('list')
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const localeRef = useRef(locale)
  const loadPlaylistsRef = useRef(loadPlaylists)

  const selectedPlaylist = useMemo(() => {
    return (
      playlists.find((playlist) => playlist.id === selectedPlaylistId) || playlists[0] || null
    )
  }, [playlists, selectedPlaylistId])

  useEffect(() => {
    localeRef.current = locale
    loadPlaylistsRef.current = loadPlaylists
  })

  useEffect(() => {
    void loadPlaylistsRef.current()

    void (async () => {
      setChatConfigError('')

      try {
        const response = await fetch(apiUrl('/api/playlist-studio/chat/sessions'))
        const payload: unknown = await response.json()

        if (!response.ok || !payload || typeof payload !== 'object') {
          const error =
            payload && typeof payload === 'object' && 'error' in payload
              ? String((payload as { error?: unknown }).error)
              : pick(localeRef.current, 'Failed to load chat sessions.', '채팅 세션을 불러오지 못했습니다.')
          throw new Error(error)
        }

        const config = payload as {
          enabled?: boolean
          repoUrl?: string
          currentSessionId?: string
          sessions?: ChatSession[]
        }

        setRepoUrl((current) => config.repoUrl || current)

        if (!config.enabled) {
          setChatConfigError(pick(localeRef.current, 'Codex chat is disabled.', 'Codex 채팅 기능이 비활성 상태입니다.'))
          return
        }

        setActiveSessionId('')
        setSessions([])
        setMessages([])

        const resetPayload = await requestChatSessionReset()
        setRepoUrl((current) => resetPayload.repoUrl || current)
        setSessions(resetPayload.sessions || [])
      } catch (error) {
        setChatConfigError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [])

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [chatBusy, messages])

  async function loadPlaylists(force = false) {
    setPlaylistsLoading(true)
    setPlaylistError('')

    try {
      const response = await fetch(
        apiUrl(`/api/playlist-studio/playlists${force ? '?force=true' : ''}`),
      )
      const payload: unknown = await response.json()

      if (!response.ok || !payload || typeof payload !== 'object') {
        const error =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error?: unknown }).error)
            : pick(locale, 'Failed to load playlists.', '플레이리스트를 불러오지 못했습니다.')
        throw new Error(error)
      }

      const nextPlaylists = (payload as { playlists?: PlaylistSummary[] }).playlists || []
      setPlaylists(nextPlaylists)
      setSelectedPlaylistId((current) => {
        if (nextPlaylists.some((playlist) => playlist.id === current)) {
          return current
        }

        return nextPlaylists[0]?.id || ''
      })
    } catch (error) {
      setPlaylistError(error instanceof Error ? error.message : String(error))
    } finally {
      setPlaylistsLoading(false)
    }
  }

  async function loadHistory(sessionId: string) {
    setMessages(await requestChatHistory(sessionId))
  }

  async function selectSession(sessionId: string) {
    setChatBusy(true)
    setChatConfigError('')

    try {
      const response = await fetch(apiUrl('/api/playlist-studio/chat/sessions/select'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const payload: unknown = await response.json()

      if (!response.ok || !payload || typeof payload !== 'object') {
        const error =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error?: unknown }).error)
            : pick(locale, 'Failed to select the session.', '세션을 선택하지 못했습니다.')
        throw new Error(error)
      }

      const nextSessionId = (payload as { currentSessionId?: string }).currentSessionId || sessionId
      setActiveSessionId(nextSessionId)
      setSessions((payload as { sessions?: ChatSession[] }).sessions || [])
      await loadHistory(nextSessionId)
    } catch (error) {
      setChatConfigError(error instanceof Error ? error.message : String(error))
    } finally {
      setChatBusy(false)
    }
  }

  async function createSession({ reset = true }: { reset?: boolean } = {}) {
    setChatBusy(true)
    setChatConfigError('')
    if (reset) {
      setActiveSessionId('')
      setSessions([])
      setMessages([])
    }

    try {
      const payload = await requestChatSession(reset)

      const sessionId =
        payload.session?.id ||
        payload.currentSessionId ||
        ''

      setActiveSessionId(sessionId)
      setSessions(payload.sessions || [])
      if (sessionId) {
        await loadHistory(sessionId)
      }
    } catch (error) {
      setChatConfigError(error instanceof Error ? error.message : String(error))
    } finally {
      setChatBusy(false)
    }
  }

  async function sendChat(message: string) {
    const trimmed = message.trim()
    if (!trimmed || !activeSessionId || chatBusy) return

    setChatInput('')
    setChatBusy(true)
    setChatConfigError('')
    setMessages((current) => [
      ...current,
      { role: 'user', content: trimmed, at: new Date().toISOString() },
    ])

    try {
      const response = await fetch(apiUrl('/api/playlist-studio/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, sessionId: activeSessionId }),
      })
      const payload: unknown = await response.json()

      if (!response.ok || !payload || typeof payload !== 'object') {
        const error =
          payload && typeof payload === 'object' && 'assistant' in payload
            ? String((payload as { assistant?: ChatMessage }).assistant?.content)
            : payload && typeof payload === 'object' && 'error' in payload
              ? String((payload as { error?: unknown }).error)
              : pick(locale, 'Request failed.', '요청에 실패했습니다.')
        throw new Error(error)
      }

      const assistant = (payload as { assistant?: ChatMessage }).assistant
      if (assistant) {
        setMessages((current) => [...current, assistant])
      }

      const nextSessions = (payload as { sessions?: ChatSession[] }).sessions
      if (nextSessions) {
        setSessions(nextSessions)
      }

      const nextSessionId = (payload as { currentSessionId?: string }).currentSessionId
      if (nextSessionId) {
        setActiveSessionId(nextSessionId)
      }

      await loadPlaylists(true)
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: `${pick(locale, 'Error', '오류')}: ${error instanceof Error ? error.message : String(error)}`,
          at: new Date().toISOString(),
        },
      ])
    } finally {
      setChatBusy(false)
    }
  }

  return (
    <section className="playlist-studio">
      <nav className="playlist-mobile-tabs" aria-label={pick(locale, 'playlist studio panels', '플레이리스트 스튜디오 패널')}>
        <button
          type="button"
          className={activePanel === 'chat' ? 'active' : ''}
          onClick={() => setActivePanel('chat')}
        >
          {pick(locale, 'Chat', '채팅')}
        </button>
        <button
          type="button"
          className={activePanel === 'list' ? 'active' : ''}
          onClick={() => setActivePanel('list')}
        >
          {pick(locale, 'List', '목록')}
        </button>
        <button
          type="button"
          className={activePanel === 'viewer' ? 'active' : ''}
          onClick={() => setActivePanel('viewer')}
        >
          {pick(locale, 'Player', '플레이어')}
        </button>
      </nav>

      <div className="playlist-grid">
        <section
          className={`playlist-panel playlist-chat ${activePanel === 'chat' ? 'is-current' : ''}`}
        >
          <div className="playlist-chat-head">
            <a href={repoUrl} target="_blank" rel="noreferrer">
              spotify-mcp-server
            </a>
            <button
              type="button"
              disabled={chatBusy}
              onClick={() => void createSession({ reset: true })}
            >
              {pick(locale, 'New Session', '새 세션')}
            </button>
          </div>

          <div className="playlist-session-strip" aria-label={pick(locale, 'chat session list', '채팅 세션 목록')}>
            {sessions.length > 0 ? (
              sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={session.id === activeSessionId ? 'active' : ''}
                  disabled={chatBusy}
                  onClick={() => void selectSession(session.id)}
                >
                  <strong>{session.title || pick(locale, 'Untitled session', '제목 없는 세션')}</strong>
                  <small>{formatSessionMeta(session, locale)}</small>
                </button>
              ))
            ) : (
              <span>{pick(locale, 'Press New Session to start.', '새 세션을 눌러 시작하세요.')}</span>
            )}
          </div>

          <div className="playlist-chat-messages" ref={messagesRef} aria-live="polite">
            {chatConfigError ? <div className="playlist-chat-empty">{chatConfigError}</div> : null}
            {!chatConfigError && messages.length === 0 ? (
              <div className="playlist-chat-empty">
                {pick(
                  locale,
                  'Start a new session to request Spotify playlist recommendations, creation, and cleanup.',
                  '새 세션을 누르면 Spotify 플레이리스트 추천, 생성, 정리 요청을 시작할 수 있습니다.',
                )}
              </div>
            ) : null}
            {messages.map((message, index) => (
              <div key={`${message.at || index}-${index}`} className={`playlist-bubble ${message.role}`}>
                {message.content}
              </div>
            ))}
            {chatBusy ? (
              <div className="playlist-bubble assistant pending">
                <span>{pick(locale, 'Working', '처리 중')}</span>
                <span className="playlist-pending-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : null}
          </div>

          <form
            className="playlist-chat-form"
            onSubmit={(event) => {
              event.preventDefault()
              void sendChat(chatInput)
            }}
          >
            <textarea
              value={chatInput}
              disabled={!activeSessionId || chatBusy}
              rows={4}
              placeholder={pick(
                locale,
                'Example: Make a public 30-track playlist from obscure but locally popular genres',
                '예: 생소하지만 현지에서 인기 많은 장르로 30곡 공개 플레이리스트 만들어줘',
              )}
              onChange={(event) => setChatInput(event.target.value)}
            />
            <button type="submit" disabled={!activeSessionId || !chatInput.trim() || chatBusy}>
              {pick(locale, 'Send', '보내기')}
            </button>
          </form>
        </section>

        <section
          className={`playlist-panel playlist-list-panel ${
            activePanel === 'list' ? 'is-current' : ''
          }`}
        >
          <div className="playlist-list-head">
            <div>
              <p>{pick(locale, 'Public Playlists', '공개 플레이리스트')}</p>
              <h2>{pick(locale, 'My Public Playlists', '내 공개 플레이리스트')}</h2>
            </div>
            <button
              type="button"
              disabled={playlistsLoading}
              onClick={() => void loadPlaylists(true)}
            >
              {pick(locale, 'Refresh', '새로고침')}
            </button>
          </div>

          <div className="playlist-list">
            {playlistsLoading ? <div className="playlist-list-empty">{pick(locale, 'Loading...', '불러오는 중...')}</div> : null}
            {!playlistsLoading && playlistError ? (
              <div className="playlist-list-empty">{pick(locale, 'Error', '오류')}: {playlistError}</div>
            ) : null}
            {!playlistsLoading && !playlistError && playlists.length === 0 ? (
              <div className="playlist-list-empty">{pick(locale, 'No public playlists found.', 'public 플레이리스트가 없습니다.')}</div>
            ) : null}
            {playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                className={playlist.id === selectedPlaylist?.id ? 'active' : ''}
                onClick={() => {
                  setSelectedPlaylistId(playlist.id)
                  setActivePanel('viewer')
                }}
              >
                {playlist.imageUrl ? <img src={playlist.imageUrl} alt="" /> : <span />}
                <strong>{playlist.name || pick(locale, 'Untitled playlist', '제목 없는 플레이리스트')}</strong>
                <small>{formatCount(locale, playlist.tracksTotal || 0, 'track', 'tracks', '곡')}</small>
              </button>
            ))}
          </div>
        </section>

        <section
          className={`playlist-panel playlist-viewer ${
            activePanel === 'viewer' ? 'is-current' : ''
          }`}
        >
          <div className="playlist-viewer-head">
            <div>
              <p>{pick(locale, 'Spotify Public Playlist', 'Spotify 공개 플레이리스트')}</p>
              <h2>{selectedPlaylist?.name || pick(locale, 'Select a playlist', '플레이리스트를 선택하세요')}</h2>
              <span>
                {selectedPlaylist?.description ||
                  pick(locale, 'Only public playlists from the current account are shown.', '목록은 현재 계정의 public 플레이리스트만 보여줍니다.')}
              </span>
            </div>
            {selectedPlaylist ? (
              <a href={selectedPlaylist.openUrl} target="_blank" rel="noreferrer">
                {pick(locale, 'Open in Spotify', 'Spotify에서 열기')}
              </a>
            ) : null}
          </div>

          <div className="playlist-frame-wrap">
            {selectedPlaylist?.embedUrl ? (
              <iframe
                title="Spotify playlist viewer"
                src={selectedPlaylist.embedUrl}
                loading="lazy"
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              />
            ) : (
              <div className="playlist-list-empty">{pick(locale, 'No playlist selected.', '선택된 플레이리스트가 없습니다.')}</div>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

export default PlaylistStudio
